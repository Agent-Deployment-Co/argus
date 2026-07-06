// Argus tray app: a thin native shell around the `argus` sidecar.
//
// On launch it starts `argus run` (index + serve, plus sync when a Hub URL + key are configured —
// otherwise `--no-sync`, all supervised in one process) on a free local port and exposes a tray menu
// whose items map onto the CLI's command surface. Logs are written to rotating files. "Open Argus"
// opens the user's default browser at the served URL; the only embedded webview is the bundled About
// screen.
//
// The browser never talks to the sidecar's port directly. A fixed "front-door" port (`proxy.rs`,
// preferring the CLI's own default `4242`) is proxied to whatever port the sidecar currently holds,
// which is re-picked on every start. That keeps any already-open dashboard tab working across a
// sidecar restart even though the backend port underneath it changes.
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{
    sync::atomic::{AtomicBool, AtomicU16, Ordering},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::OptionalExtension;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::{Update, UpdaterExt};

mod proxy;

/// Shared state: the local port the browser/tabs talk to (`front_port`, proxied by
/// `proxy::start_proxy`) — normally fixed at `PREFERRED_FRONT_PORT` for the app's lifetime, but
/// corrected once if that port turns out to be unavailable when the proxy actually binds — the
/// sidecar's actual (re-picked on every restart) port, the handle to the running child (if any),
/// the tray menu items we update as that state changes, and a flag marking a stop as intentional
/// (so a crash can be told apart from a user-requested Stop / Quit).
struct AppState {
    front_port: Arc<AtomicU16>,
    backend_port: Arc<AtomicU16>,
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
    status_item: MenuItem<Wry>,
    open_item: MenuItem<Wry>,
    start_item: MenuItem<Wry>,
    stop_item: MenuItem<Wry>,
    update_item: MenuItem<Wry>,
    update_available: AtomicBool,
    checking_update: AtomicBool,
    last_update_check_ms: Mutex<Option<u64>>,
    latest_version: Mutex<Option<String>>,
}

const ABOUT_WINDOW_LABEL: &str = "about";
const CHECK_FOR_UPDATES_LABEL: &str = "Check for updates";
const INSTALL_UPDATE_LABEL: &str = "Install Update";
const CHECKING_FOR_UPDATES_LABEL: &str = "Checking for updates...";
const INSTALLING_UPDATE_LABEL: &str = "Installing Update...";
const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES: u64 = 60;
const DESKTOP_LOG_MAX_BYTES: u64 = 5_000_000;
/// The CLI's own default port (`src/cli.ts`'s `DEFAULT_PORT`). Tried first for the front-door proxy
/// so `http://localhost:4242` keeps working whether Argus is run standalone or via the desktop app.
const PREFERRED_FRONT_PORT: u16 = 4242;

/// Show a native notification. Best-effort: a failure to notify is itself only logged.
pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("could not show notification: {err}");
    }
}

/// Ask the OS for an unused localhost port by binding to :0 and reading back the assignment.
fn pick_free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("binding a free port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("reading the bound port: {e}"))
}

/// The bundled web assets live under `<resources>/web`. Returns it as a string for the sidecar's
/// `ARGUS_WEB_ROOT`, which `serve.ts` honors above every other candidate.
fn web_root(app: &AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?.join("web");
    dir.to_str().map(|s| s.to_string())
}

fn sidecar_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("argus.log"))
        .map_err(|e| format!("locating the sidecar log file: {e}"))
}

fn rotated_sidecar_log_file(path: &Path) -> PathBuf {
    let mut rotated = path.to_path_buf();
    let mut file_name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| OsString::from("argus.log"));
    file_name.push(".1");
    rotated.set_file_name(file_name);
    rotated
}

fn rotate_sidecar_log(path: &Path) -> std::io::Result<()> {
    let rotated = rotated_sidecar_log_file(path);
    match std::fs::remove_file(&rotated) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    match std::fs::rename(path, rotated) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    Ok(())
}

fn append_sidecar_log(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    append_sidecar_log_with_limit(path, bytes, DESKTOP_LOG_MAX_BYTES)
}

fn append_sidecar_log_with_limit(path: &Path, bytes: &[u8], max_bytes: u64) -> std::io::Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let incoming = bytes.len() as u64;
    if path
        .metadata()
        .map(|meta| meta.len() != 0 && meta.len().saturating_add(incoming) > max_bytes)
        .unwrap_or(false)
    {
        rotate_sidecar_log(path)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.flush()
}

#[cfg(debug_assertions)]
fn mirror_sidecar_log(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

#[cfg(not(debug_assertions))]
fn mirror_sidecar_log(_bytes: &[u8]) {}

#[cfg(test)]
mod tests {
    use super::{append_sidecar_log_with_limit, parse_git_config_user_email, rotated_sidecar_log_file};
    use std::io;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn parses_user_email_from_a_user_section() {
        assert_eq!(
            parse_git_config_user_email("[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n"),
            Some("ada@example.com".to_string())
        );
    }

    #[test]
    fn ignores_other_and_subsections_named_user() {
        assert_eq!(
            parse_git_config_user_email(
                "[user \"work\"]\n\temail = not-this@example.com\n[core]\n\temail = nope@example.com\n"
            ),
            None
        );
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        assert_eq!(
            parse_git_config_user_email(
                "; comment\n[user]\n# another comment\n\nemail = grace@example.com\n"
            ),
            Some("grace@example.com".to_string())
        );
    }

    #[test]
    fn returns_none_for_missing_or_blank_email() {
        assert_eq!(parse_git_config_user_email("[user]\nname = only@example.com\n"), None);
        assert_eq!(parse_git_config_user_email("[user]\nemail =   \n"), None);
        assert_eq!(parse_git_config_user_email(""), None);
    }

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    fn test_log_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "argus-sidecar-log-test-{}-{}",
                std::process::id(),
                NEXT_TEST_DIR.fetch_add(1, Ordering::SeqCst)
            ))
            .join("argus.log")
    }

    #[test]
    fn sidecar_log_appends_below_the_size_limit() -> io::Result<()> {
        let path = test_log_path();
        append_sidecar_log_with_limit(&path, b"hello", 10)?;
        append_sidecar_log_with_limit(&path, b"!", 10)?;

        assert_eq!(std::fs::read(&path)?, b"hello!");
        assert!(!rotated_sidecar_log_file(&path).exists());

        std::fs::remove_dir_all(path.parent().unwrap())?;
        Ok(())
    }

    #[test]
    fn sidecar_log_keeps_one_rotated_copy_at_the_size_limit() -> io::Result<()> {
        let path = test_log_path();
        let rotated = rotated_sidecar_log_file(&path);
        append_sidecar_log_with_limit(&path, b"recent", 10)?;
        std::fs::write(&rotated, b"older")?;

        append_sidecar_log_with_limit(&path, b"incoming", 10)?;

        assert_eq!(std::fs::read(&rotated)?, b"recent");
        assert_eq!(std::fs::read(&path)?, b"incoming");

        std::fs::remove_dir_all(path.parent().unwrap())?;
        Ok(())
    }
}

/// Reflect the running/stopped state in the tray menu: status label text and which of Start/Stop
/// is selectable.
fn refresh_status(app: &AppHandle) {
    let state = app.state::<AppState>();
    let running = state.child.lock().unwrap().is_some();
    let _ = state.status_item.set_text(if running {
        "Argus is running"
    } else {
        "Argus is stopped"
    });
    let _ = state.open_item.set_enabled(running);
    let _ = state.start_item.set_enabled(!running);
    let _ = state.stop_item.set_enabled(running);
}

/// Spawn `argus run --port <port>` as a sidecar, forwarding the web-asset location, and drain its
/// output to the log. When it exits (crash or stop), clear the handle and refresh the menu so the
/// tray never claims to be running a process that has gone away.
fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
    // Re-pick a free backend port on every spawn (not just once per app launch): the front-door
    // proxy (`proxy::start_proxy`) insulates the browser from this, so there's no reason to keep
    // relying on the previous port still being free. Propagate failure rather than falling back to
    // a fixed port here — a fallback could collide with the front-door proxy's own port.
    let port = pick_free_port()?;
    app.state::<AppState>()
        .backend_port
        .store(port, Ordering::SeqCst);
    // Enable uploads only when a Hub URL + key are configured (mirrors the CLI's resolveHubConfig).
    // Without them there's nothing to upload to, so run index + serve only. Re-checked on every
    // start, so toggling the Hub settings then using Stop/Start picks up the change.
    let sync_enabled = hub_configured();
    let mut args = vec!["run".to_string(), "--port".to_string(), port.to_string()];
    if !sync_enabled {
        args.push("--no-sync".to_string());
    }
    log::info!(
        "starting argus on port {port} ({})",
        if sync_enabled { "sync on" } else { "sync off" }
    );
    let mut command = app
        .shell()
        .sidecar("argus")
        .map_err(|e| format!("locating the argus sidecar: {e}"))?
        .args(args);
    if let Some(root) = web_root(app) {
        command = command.env("ARGUS_WEB_ROOT", root);
    }
    let sidecar_log = sidecar_log_file(app)?;
    // Tell the sidecar where its output is being logged, so the web app's Debug view can show the
    // path. The desktop shell captures stdout/stderr below and writes it here; the CLI never opens
    // this file itself.
    if let Some(log_path) = sidecar_log.to_str() {
        command = command.env("ARGUS_LOG_FILE", log_path);
    }
    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("starting the argus sidecar: {e}"))?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    if let Err(err) = append_sidecar_log(&sidecar_log, &bytes) {
                        log::warn!("writing argus sidecar output: {err}");
                    }
                    mirror_sidecar_log(&bytes);
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("[argus] sidecar exited: {:?}", payload.code);
                    let state = handle.state::<AppState>();
                    *state.child.lock().unwrap() = None;
                    // Tell a crash apart from a user-requested Stop/Quit.
                    let intentional = state.stopping.swap(false, Ordering::SeqCst);
                    refresh_status(&handle);
                    if !intentional {
                        let _ = state.status_item.set_text("Argus stopped unexpectedly");
                        notify(
                            &handle,
                            "Argus stopped",
                            "The background service exited unexpectedly. Use Start to run it again.",
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Start the sidecar if it isn't already running.
fn start(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut slot = state.child.lock().unwrap();
        if slot.is_some() {
            return;
        }
        match spawn_sidecar(app) {
            Ok(child) => *slot = Some(child),
            Err(err) => {
                log::error!("{err}");
                drop(slot);
                let _ = state.status_item.set_text("Argus couldn't start");
                notify(
                    app,
                    "Argus couldn't start",
                    "The background service failed to launch. Check Console for details.",
                );
                return;
            }
        }
    }
    refresh_status(app);
}

/// Stop the sidecar if running. `argus run` installs its own shutdown handler; killing the process
/// ends all three legs.
fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        // Mark the impending exit as intentional so the Terminated handler doesn't flag a crash.
        state.stopping.store(true, Ordering::SeqCst);
        if let Err(err) = child.kill() {
            log::warn!("stopping the argus sidecar: {err}");
        }
    }
    refresh_status(app);
}

/// Open the served dashboard in the user's default browser. Lands on the welcome overlay
/// (`?first_run=1`) instead of the bare dashboard until the modal's "Don't show this again"
/// checkbox has been ticked — the same `state.onboardingCompleted` flag `argus serve --open` checks.
fn open_dashboard(app: &AppHandle) {
    let port = app.state::<AppState>().front_port.load(Ordering::SeqCst);
    let mut url = format!("http://localhost:{port}");
    if !onboarding_completed() {
        url.push_str("?first_run=1");
    }
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        log::error!("opening the dashboard: {err}");
    }
}

/// Whether the welcome modal has already been dismissed with "Don't show this again"
/// (`state.onboardingCompleted` in `argus.json`). Tolerant: a missing/malformed config reads as
/// "not completed", so a fresh install shows the welcome overlay.
///
/// The onboarding flow is macOS-only for now: Windows never reads or writes
/// `state.onboardingCompleted`, so this always reads as "completed" there, which means
/// `open_dashboard` never appends `?first_run=1` and `maybe_open_on_first_run` never auto-opens.
fn onboarding_completed() -> bool {
    if !cfg!(target_os = "macos") {
        return true;
    }
    read_argus_config_json()
        .and_then(|json| json_bool_setting(json.get("state").and_then(|v| v.get("onboardingCompleted"))))
        .unwrap_or(false)
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        non_empty_env("USERPROFILE").map(PathBuf::from).or_else(|| {
            let drive = non_empty_env("HOMEDRIVE")?;
            let path = non_empty_env("HOMEPATH")?;
            Some(PathBuf::from(format!("{drive}{path}")))
        })
    } else {
        non_empty_env("HOME").map(PathBuf::from)
    }
}

fn argus_data_dir() -> Option<PathBuf> {
    if let Some(path) = non_empty_env("ARGUS_DATA_DIR") {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = non_empty_env("ARGUS_HOME") {
        return Some(PathBuf::from(path).join("data"));
    }
    if let Some(path) = non_empty_env("XDG_DATA_HOME") {
        return Some(PathBuf::from(path).join("argus"));
    }
    if cfg!(target_os = "macos") {
        return home_dir().map(|dir| dir.join("Library/Application Support/argus"));
    }
    if cfg!(windows) {
        if let Some(path) = non_empty_env("LOCALAPPDATA") {
            return Some(PathBuf::from(path).join("Argus").join("Data"));
        }
    }
    home_dir().map(|dir| dir.join(".local").join("share").join("argus"))
}

fn argus_store_file() -> Option<PathBuf> {
    argus_data_dir().map(|dir| dir.join("argus.db"))
}

/// Where `argus.json` lives, mirroring the CLI's `defaultArgusConfigDir` resolution chain. Read
/// directly (rather than shelling out to the CLI) so the Hub check stays synchronous and works
/// before the sidecar is up — the same trade-off `read_store_client_id` makes for `argus.db`.
fn argus_config_dir() -> Option<PathBuf> {
    if let Some(path) = non_empty_env("ARGUS_CONFIG_DIR") {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = non_empty_env("ARGUS_HOME") {
        return Some(PathBuf::from(path).join("config"));
    }
    if let Some(path) = non_empty_env("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(path).join("argus"));
    }
    if cfg!(target_os = "macos") {
        return home_dir().map(|dir| dir.join("Library/Application Support/argus"));
    }
    if cfg!(windows) {
        if let Some(path) = non_empty_env("APPDATA") {
            return Some(PathBuf::from(path).join("Argus"));
        }
    }
    home_dir().map(|dir| dir.join(".config").join("argus"))
}

fn read_argus_config_json() -> Option<serde_json::Value> {
    let dir = argus_config_dir()?;
    let text = std::fs::read_to_string(dir.join("argus.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()
}

fn parse_bool_setting(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn json_bool_setting(value: Option<&serde_json::Value>) -> Option<bool> {
    match value? {
        serde_json::Value::Bool(value) => Some(*value),
        serde_json::Value::String(value) => parse_bool_setting(value),
        serde_json::Value::Number(value) => value.as_i64().and_then(|n| match n {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        }),
        _ => None,
    }
}

fn parse_minutes_setting(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().filter(|value| *value > 0)
}

fn json_minutes_setting(value: Option<&serde_json::Value>) -> Option<u64> {
    match value? {
        serde_json::Value::Number(value) => value.as_u64().filter(|value| *value > 0),
        serde_json::Value::String(value) => parse_minutes_setting(value),
        _ => None,
    }
}

/// Whether the desktop shell should install signed updates automatically. Defaults to true, matching
/// the shared `autoUpdate.enabled` setting in `argus.json`.
fn auto_update_enabled() -> bool {
    if let Some(value) = non_empty_env("ARGUS_AUTO_UPDATE_ENABLED") {
        return parse_bool_setting(&value).unwrap_or(true);
    }
    read_argus_config_json()
        .and_then(|json| json_bool_setting(json.get("autoUpdate").and_then(|v| v.get("enabled"))))
        .unwrap_or(true)
}

/// Minutes between background desktop update checks. Defaults to 60.
fn auto_update_check_interval_minutes() -> u64 {
    if let Some(value) = non_empty_env("ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES") {
        return parse_minutes_setting(&value).unwrap_or(DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES);
    }
    read_argus_config_json()
        .and_then(|json| {
            json_minutes_setting(
                json.get("autoUpdate")
                    .and_then(|v| v.get("checkIntervalMinutes")),
            )
        })
        .unwrap_or(DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES)
}

/// True when both the Hub URL and key are configured — the same condition the CLI's
/// `resolveHubConfig` uses to switch on Hub uploads. When true the tray runs `argus run` with sync on
/// (no `--no-sync`). Tolerant: a missing or malformed config simply reads as "not configured", so the
/// service still starts (index + serve only).
fn hub_configured() -> bool {
    hub_url_present() && hub_key_present()
}

/// True when a non-empty Hub URL is set in the env or `argus.json`. The URL is not a secret, so it
/// stays in `argus.json` (it's never moved into the keychain).
fn hub_url_present() -> bool {
    if non_empty_env("ARGUS_HUB_URL").is_some() {
        return true;
    }
    read_argus_config_json()
        .and_then(|json| {
            json.get("hub")
                .and_then(|hub| hub.get("url"))
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Resolve the Hub key the same way the CLI's `resolveHubKey` does: the `ARGUS_HUB_KEY` env var wins,
/// then the OS secret store. On macOS that store is the login keychain — read via the system
/// `security` tool using the same `(service, account)` identity the CLI writes (`secrets.ts`'s
/// `KEYCHAIN_SERVICE`). Reading through `/usr/bin/security` (as the CLI also does) keeps the item's
/// ACL satisfied, so this never raises a keychain prompt. A legacy plaintext `hub.key` still in
/// `argus.json` (pre-migration) also counts, which doubles as the fallback on platforms whose secret
/// store we don't read here. Without this, a key the CLI has already migrated into the keychain would
/// read as "not configured" and the tray would wrongly launch with `--no-sync`.
fn hub_key_present() -> bool {
    if non_empty_env("ARGUS_HUB_KEY").is_some() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        // `security find-generic-password -w` prints just the secret and exits nonzero when the item
        // is absent; command_stdout maps both "nonzero" and "empty" to None.
        if command_stdout(
            "/usr/bin/security",
            &[
                "find-generic-password",
                "-s",
                "co.agentdeployment.argus",
                "-a",
                "ARGUS_HUB_KEY",
                "-w",
            ],
        )
        .is_some()
        {
            return true;
        }
    }
    read_argus_config_json()
        .and_then(|json| {
            json.get("hub")
                .and_then(|hub| hub.get("key"))
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Read the per-install client id out of the store's `store_metadata` bag. Opens `argus.db`
/// read-only via the bundled SQLite (statically linked, so no system libsqlite3 is required on any
/// platform) and tolerates a concurrent writer — the running sidecar keeps the store in WAL mode.
fn read_store_client_id(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM store_metadata WHERE key = 'client_id' LIMIT 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(|e| e.to_string())
}

fn local_client_id() -> Option<String> {
    let path = argus_store_file()?;
    match read_store_client_id(&path) {
        Ok(client_id) => client_id,
        Err(err) => {
            log::debug!("reading the Argus client id from {}: {err}", path.display());
            None
        }
    }
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn os_username() -> Option<String> {
    non_empty_env("USER").or_else(|| non_empty_env("USERNAME"))
}

fn os_hostname() -> Option<String> {
    non_empty_env("HOSTNAME").or_else(|| command_stdout("hostname", &[]))
}

/// Parse the `user.email` value out of a git config file's contents (INI-like: `[section]`
/// headers, `key = value` lines, `;`/`#` comments). Only looks at top-level `[user]` sections —
/// subsections like `[user "foo"]` aren't git identity and are skipped. Mirrors
/// `parseGitConfigUserName` in `src/client-fingerprint.ts` (same rationale: avoid shelling out to
/// `git`, which pops up a Xcode Command Line Tools install prompt on macOS when they're missing).
fn parse_git_config_user_email(contents: &str) -> Option<String> {
    let mut in_user_section = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let inner = &line[1..line.len() - 1];
            in_user_section = inner.trim().eq_ignore_ascii_case("user");
            continue;
        }
        if !in_user_section {
            continue;
        }
        if let Some(rest) = line.split_once('=') {
            let (key, value) = rest;
            if key.trim().eq_ignore_ascii_case("email") {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Read the user's git email from their global gitconfig — `$GIT_CONFIG_GLOBAL` if set, else
/// `$HOME/.gitconfig` — without invoking the `git` binary.
fn git_config_user_email() -> Option<String> {
    let path = non_empty_env("GIT_CONFIG_GLOBAL")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|dir| dir.join(".gitconfig")))?;
    let contents = std::fs::read_to_string(path).ok()?;
    parse_git_config_user_email(&contents)
}

fn sync_user_id() -> String {
    if let Some(email) = git_config_user_email() {
        return email;
    }
    if let (Some(username), Some(hostname)) = (os_username(), os_hostname()) {
        return format!("{username}@{hostname}");
    }
    os_username().unwrap_or_else(|| "unknown".to_string())
}

fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn about_info(app: &AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let latest_version = state
        .latest_version
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let last_update_check_ms = *state.last_update_check_ms.lock().unwrap();
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "latestVersion": latest_version,
        "lastUpdateCheckMs": last_update_check_ms,
        "buildNumber": env!("ARGUS_BUILD_ID"),
        "dashboardUrl": format!("http://localhost:{}", state.front_port.load(Ordering::SeqCst)),
        "clientId": local_client_id(),
        "syncUserId": sync_user_id(),
    })
}

fn refresh_about_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) else {
        return;
    };
    let info = about_info(app);
    let _ = window.eval(format!(
        "window.__ARGUS_ABOUT__ = {info}; window.__ARGUS_SET_ABOUT__?.({info});"
    ));
}

fn record_update_check_attempt(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(checked_at) = now_ms() {
        *state.last_update_check_ms.lock().unwrap() = Some(checked_at);
    }
    refresh_about_window(app);
}

fn record_update_check(app: &AppHandle, latest_version: Option<String>) {
    let state = app.state::<AppState>();
    if let Some(checked_at) = now_ms() {
        *state.last_update_check_ms.lock().unwrap() = Some(checked_at);
    }
    *state.latest_version.lock().unwrap() =
        Some(latest_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()));
    refresh_about_window(app);
}

/// Open or focus the bundled About screen. The screen is static HTML; this initialization script
/// only supplies runtime metadata, so the webview does not need any Tauri command permissions.
fn show_about(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
        let info = about_info(app);
        let _ = window.eval(format!(
            "window.__ARGUS_ABOUT__ = {info}; window.__ARGUS_SET_ABOUT__?.({info});"
        ));
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let info = about_info(app);
    let init_script = format!("window.__ARGUS_ABOUT__ = {info};");

    let result = WebviewWindowBuilder::new(
        app,
        ABOUT_WINDOW_LABEL,
        WebviewUrl::App("about.html".into()),
    )
    .title("About Argus")
    .inner_size(460.0, 520.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .center()
    .focused(true)
    .initialization_script(init_script)
    .build();

    match result {
        Ok(window) => {
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(err) = window_for_close.hide() {
                        log::warn!("hiding About window: {err}");
                    }
                }
            });
            let _ = window.set_focus();
        }
        Err(err) => {
            log::error!("opening About window: {err}");
            notify(
                app,
                "Couldn't open About",
                "The About window failed to open. Check Console for details.",
            );
        }
    }
}

async fn check_available_update(app: &AppHandle) -> Result<Option<Update>, String> {
    record_update_check_attempt(app);
    let update = app
        .updater()
        .map_err(|e| format!("preparing updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("checking for updates: {e}"))?;
    record_update_check(app, update.as_ref().map(|update| update.version.clone()));
    Ok(update)
}

async fn install_update(app: AppHandle, update: Update) -> Result<bool, String> {
    let version = update.version.clone();
    log::info!("installing Argus update {version}");
    notify(
        &app,
        "Argus update found",
        &format!("Installing version {version}. Argus will restart when the update is ready."),
    );

    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                if let Some(content_length) = content_length {
                    log::info!("downloaded update bytes: {downloaded}/{content_length}");
                } else {
                    log::info!("downloaded update bytes: {downloaded}");
                }
            },
            || {
                log::info!("update download finished");
            },
        )
        .await
        .map_err(|e| format!("installing update: {e}"))?;

    stop(&app);
    notify(&app, "Argus updated", "Restarting to finish the update.");
    app.restart()
}

enum ManualUpdateResult {
    Installing,
    Available(String),
    Current,
}

fn set_update_menu(app: &AppHandle, label: &str, enabled: bool) {
    let state = app.state::<AppState>();
    let _ = state.update_item.set_text(label);
    let _ = state.update_item.set_enabled(enabled);
}

fn reset_update_menu(app: &AppHandle, available: bool) {
    let state = app.state::<AppState>();
    state.update_available.store(available, Ordering::SeqCst);
    set_update_menu(
        app,
        if available {
            INSTALL_UPDATE_LABEL
        } else {
            CHECK_FOR_UPDATES_LABEL
        },
        true,
    );
}

async fn check_for_updates_from_menu_inner(
    app: AppHandle,
    install_known_update: bool,
) -> Result<ManualUpdateResult, String> {
    let Some(update) = check_available_update(&app).await? else {
        return Ok(ManualUpdateResult::Current);
    };

    let version = update.version.clone();
    if install_known_update || auto_update_enabled() {
        install_update(app, update).await?;
        Ok(ManualUpdateResult::Installing)
    } else {
        Ok(ManualUpdateResult::Available(version))
    }
}

fn check_for_updates_from_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.checking_update.swap(true, Ordering::SeqCst) {
        return;
    }
    let install_known_update = state.update_available.load(Ordering::SeqCst);
    let _ = state.update_item.set_text(if install_known_update {
        INSTALLING_UPDATE_LABEL
    } else {
        CHECKING_FOR_UPDATES_LABEL
    });
    let _ = state.update_item.set_enabled(false);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = check_for_updates_from_menu_inner(handle.clone(), install_known_update).await;
        let state = handle.state::<AppState>();
        state.checking_update.store(false, Ordering::SeqCst);

        match result {
            Ok(ManualUpdateResult::Installing) => {}
            Ok(ManualUpdateResult::Available(version)) => {
                reset_update_menu(&handle, true);
                notify(
                    &handle,
                    "Argus update available",
                    &format!("Version {version} is ready to install."),
                );
            }
            Ok(ManualUpdateResult::Current) => {
                reset_update_menu(&handle, false);
                notify(&handle, "Argus is up to date", "No update is available.");
            }
            Err(err) => {
                log::error!("{err}");
                reset_update_menu(&handle, install_known_update);
                notify(
                    &handle,
                    "Couldn't check for updates",
                    "The update check failed. Check Console for details.",
                );
            }
        }
    });
}

/// Auto-open the dashboard on a fresh install, once the service is up and the very first update
/// check has settled — so a signed update being auto-installed (which restarts the whole app, see
/// `install_update`) always wins the race instead of racing a stale sidecar. Only ever called once,
/// right after the first background update check in `start_update_check_loop`; a completed update
/// install never reaches this point in the same process (it restarts before `run_background_update_check`
/// returns), so on relaunch this runs again against the now-current version. If auto-update is off and
/// an update just sits available for manual approval, that shouldn't block first-run forever, so this
/// still opens.
fn maybe_open_on_first_run(app: &AppHandle) {
    if onboarding_completed() {
        return;
    }
    if app.state::<AppState>().child.lock().unwrap().is_none() {
        // The sidecar isn't running (it failed to start) — nothing to open yet.
        return;
    }
    open_dashboard(app);
}

async fn sleep_update_interval() {
    let minutes = auto_update_check_interval_minutes();
    let seconds = minutes.saturating_mul(60);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_secs(seconds));
    })
    .await;
}

async fn check_for_updates_in_background(app: AppHandle) -> Result<(), String> {
    let Some(update) = check_available_update(&app).await? else {
        reset_update_menu(&app, false);
        return Ok(());
    };

    let version = update.version.clone();
    if auto_update_enabled() {
        install_update(app, update).await?;
    } else {
        let was_available = app
            .state::<AppState>()
            .update_available
            .swap(true, Ordering::SeqCst);
        set_update_menu(&app, INSTALL_UPDATE_LABEL, true);
        if !was_available {
            notify(
                &app,
                "Argus update available",
                &format!("Version {version} is ready to install."),
            );
        }
    }
    Ok(())
}

async fn run_background_update_check(app: AppHandle) {
    if app
        .state::<AppState>()
        .checking_update
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let result = check_for_updates_in_background(app.clone()).await;
    app.state::<AppState>()
        .checking_update
        .store(false, Ordering::SeqCst);
    if let Err(err) = result {
        log::error!("{err}");
    }
}

/// Check for updates immediately, then repeat using `autoUpdate.checkIntervalMinutes`. The very
/// first check gates the first-run auto-open (`maybe_open_on_first_run`) so it never races an
/// update install.
fn start_update_check_loop(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut first_check = true;
        loop {
            run_background_update_check(handle.clone()).await;
            if first_check {
                first_check = false;
                maybe_open_on_first_run(&handle);
            }
            sleep_update_interval().await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // The sidecar writes its own timestamped log lines directly to argus.log. Keep the
            // desktop shell's own diagnostics in a separate rotating file so those Rust-formatted
            // lines don't wrap the CLI's log format. In dev, also mirror desktop lines to stdout.
            let mut log_builder = tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepOne)
                .max_file_size(DESKTOP_LOG_MAX_BYTES.into())
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("argus-desktop".into()),
                }));
            if cfg!(debug_assertions) {
                log_builder = log_builder.target(Target::new(TargetKind::Stdout));
            }
            app.handle().plugin(log_builder.build())?;

            // No Dock icon / no app-switcher entry — this is a menu-bar accessory.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let status =
                MenuItem::with_id(app, "status", "Argus is starting…", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Argus", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let update_item =
                MenuItem::with_id(app, "updates", CHECK_FOR_UPDATES_LABEL, true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "About Argus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Argus", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &PredefinedMenuItem::separator(app)?,
                    &open,
                    &start_item,
                    &stop_item,
                    &update_item,
                    &about,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            // `front_port` starts optimistic at the preferred port; `proxy::start_proxy` corrects it
            // (and notifies the user) if that port turns out to be unavailable when it actually binds.
            let front_port = Arc::new(AtomicU16::new(PREFERRED_FRONT_PORT));
            let backend_port = Arc::new(AtomicU16::new(0));
            proxy::start_proxy(
                PREFERRED_FRONT_PORT,
                backend_port.clone(),
                front_port.clone(),
                app.handle().clone(),
            );

            app.manage(AppState {
                front_port,
                backend_port,
                child: Mutex::new(None),
                stopping: AtomicBool::new(false),
                status_item: status,
                open_item: open,
                start_item,
                stop_item,
                update_item,
                update_available: AtomicBool::new(false),
                checking_update: AtomicBool::new(false),
                last_update_check_ms: Mutex::new(None),
                latest_version: Mutex::new(None),
            });

            let tray_icon = Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))?;

            TrayIconBuilder::with_id("main")
                .tooltip("Argus")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .icon(tray_icon)
                .icon_as_template(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => open_dashboard(app),
                    "start" => start(app),
                    "stop" => stop(app),
                    "updates" => check_for_updates_from_menu(app),
                    "about" => show_about(app),
                    "quit" => {
                        stop(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Start the background work immediately so the dashboard is live by the time the user
            // clicks "Open Argus".
            start(app.handle());

            // Check for a newer signed build in the background; the menu item lets the user ask for
            // the same check immediately.
            start_update_check_loop(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
