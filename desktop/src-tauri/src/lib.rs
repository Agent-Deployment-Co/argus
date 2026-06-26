// Argus tray app: a thin native shell around the `argus` sidecar.
//
// On launch it starts `argus run` (index + serve, plus sync when a Hub URL + key are configured —
// otherwise `--no-sync`, all supervised in one process) on a free local port and exposes a tray menu
// whose items map onto the CLI's command surface. Logs are written to a rotating file. "Open Argus"
// opens the user's default browser at the served URL; the only embedded webview is the bundled About
// screen.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::Mutex,
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
use tauri_plugin_updater::UpdaterExt;

/// Shared state: the local port the sidecar serves on, the handle to the running child (if any),
/// the tray menu items we update as that state changes, and a flag marking a stop as intentional
/// (so a crash can be told apart from a user-requested Stop / Quit).
struct AppState {
    port: u16,
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
    status_item: MenuItem<Wry>,
    open_item: MenuItem<Wry>,
    start_item: MenuItem<Wry>,
    stop_item: MenuItem<Wry>,
}

const ABOUT_WINDOW_LABEL: &str = "about";

/// Show a native notification. Best-effort: a failure to notify is itself only logged.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("could not show notification: {err}");
    }
}

/// Ask the OS for an unused localhost port by binding to :0 and reading back the assignment.
/// Falls back to the CLI's default if that somehow fails.
fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(4242)
}

/// The bundled web assets live under `<resources>/web`. Returns it as a string for the sidecar's
/// `ARGUS_WEB_ROOT`, which `serve.ts` honors above every other candidate.
fn web_root(app: &AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?.join("web");
    dir.to_str().map(|s| s.to_string())
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
    let port = app.state::<AppState>().port;
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
    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("starting the argus sidecar: {e}"))?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[argus] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[argus] {}", String::from_utf8_lossy(&line).trim_end())
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

/// Open the served dashboard in the user's default browser.
fn open_dashboard(app: &AppHandle) {
    let port = app.state::<AppState>().port;
    let url = format!("http://localhost:{port}");
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        log::error!("opening the dashboard: {err}");
    }
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

/// True when both `hub.url` and `hub.key` are configured (env or `argus.json`), the same condition
/// the CLI's `resolveHubConfig` uses to switch on Hub uploads. When true the tray runs `argus run`
/// with sync on (no `--no-sync`). Tolerant: a missing or malformed config simply reads as "not
/// configured", so the service still starts (index + serve only).
fn hub_configured() -> bool {
    if non_empty_env("ARGUS_HUB_URL").is_some() && non_empty_env("ARGUS_HUB_KEY").is_some() {
        return true;
    }
    let Some(dir) = argus_config_dir() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("argus.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let non_empty = |value: Option<&serde_json::Value>| {
        value
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };
    let hub = json.get("hub");
    non_empty(hub.and_then(|h| h.get("url"))) && non_empty(hub.and_then(|h| h.get("key")))
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

fn sync_user_id() -> String {
    if let Some(email) = command_stdout("git", &["config", "user.email"]) {
        return email;
    }
    if let (Some(username), Some(hostname)) = (os_username(), os_hostname()) {
        return format!("{username}@{hostname}");
    }
    os_username().unwrap_or_else(|| "unknown".to_string())
}

fn about_info(port: u16) -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "buildNumber": env!("ARGUS_BUILD_ID"),
        "dashboardUrl": format!("http://localhost:{port}"),
        "clientId": local_client_id(),
        "syncUserId": sync_user_id(),
    })
}

/// Open or focus the bundled About screen. The screen is static HTML; this initialization script
/// only supplies runtime metadata, so the webview does not need any Tauri command permissions.
fn show_about(app: &AppHandle) {
    let port = app.state::<AppState>().port;
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
        let info = about_info(port);
        let _ = window.eval(format!(
            "window.__ARGUS_ABOUT__ = {info}; window.__ARGUS_SET_ABOUT__?.({info});"
        ));
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let info = about_info(port);
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

/// Check for a signed desktop update, install it if available, and restart to finish.
/// Returns `Ok(true)` when an update was installed (and a restart was triggered).
async fn install_available_update(app: AppHandle) -> Result<bool, String> {
    let Some(update) = app
        .updater()
        .map_err(|e| format!("preparing updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("checking for updates: {e}"))?
    else {
        return Ok(false);
    };

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

/// Check for updates once in the background at launch. Runs silently when already up to date;
/// failures are logged but never interrupt the user (the app keeps running on the current version).
fn check_for_updates_on_launch(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match install_available_update(handle).await {
            Ok(true) | Ok(false) => {}
            Err(err) => log::error!("{err}"),
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
            // Write the sidecar's forwarded output (and our own log lines) to a rotating file so a
            // synced install keeps a durable record to troubleshoot uploads from. In dev, also mirror
            // to stdout.
            let mut log_builder = tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepOne)
                .max_file_size(5_000_000)
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("argus".into()),
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
                    &about,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            app.manage(AppState {
                port: pick_free_port(),
                child: Mutex::new(None),
                stopping: AtomicBool::new(false),
                status_item: status,
                open_item: open,
                start_item,
                stop_item,
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

            // Check for a newer signed build in the background. There's no manual "Check for
            // updates" menu item; this launch-time check is how the app stays current.
            check_for_updates_on_launch(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
