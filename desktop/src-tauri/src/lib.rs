// Argus tray app: a thin native shell around the `argus` sidecar.
//
// It creates no window. On launch it starts `argus run` (index + serve + sync, supervised in one
// process) on a free local port and exposes a tray menu whose items map onto the CLI's command
// surface. "Open dashboard" opens the user's default browser at the served URL — the dashboard is
// the existing web app, not an embedded webview.
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Shared state: the local port the sidecar serves on, and the handle to the running child (if any).
struct AppState {
    port: u16,
    child: Mutex<Option<CommandChild>>,
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
fn web_root(app: &tauri::AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?.join("web");
    dir.to_str().map(|s| s.to_string())
}

/// Spawn `argus run --port <port>` as a sidecar, forwarding the web-asset location, and drain its
/// output to the log. Returns the child handle so the tray can stop it.
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let port = app.state::<AppState>().port;
    let mut command = app
        .shell()
        .sidecar("argus")
        .map_err(|e| format!("locating the argus sidecar: {e}"))?
        .args(["run", "--port", &port.to_string()]);
    if let Some(root) = web_root(app) {
        command = command.env("ARGUS_WEB_ROOT", root);
    }
    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("starting the argus sidecar: {e}"))?;

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
                    log::warn!("[argus] sidecar exited: {:?}", payload.code)
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Start the sidecar if it isn't already running.
fn start(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.child.lock().unwrap();
    if slot.is_some() {
        return;
    }
    match spawn_sidecar(app) {
        Ok(child) => *slot = Some(child),
        Err(err) => log::error!("{err}"),
    }
}

/// Stop the sidecar if running. `argus run` installs its own shutdown handler; killing the process
/// group ends all three legs.
fn stop(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<AppState>().child.lock().unwrap().take() {
        if let Err(err) = child.kill() {
            log::warn!("stopping the argus sidecar: {err}");
        }
    }
}

/// Open the served dashboard in the user's default browser.
fn open_dashboard(app: &tauri::AppHandle) {
    let port = app.state::<AppState>().port;
    let url = format!("http://localhost:{port}");
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        log::error!("opening the dashboard: {err}");
    }
}

/// Kick off the browser sign-in flow (`argus login`, Cloudflare Access). Fire-and-forget: it opens
/// a browser and exits; the running sidecar's sync leg recovers from dormant once a token lands.
fn sign_in(app: &tauri::AppHandle) {
    match app.shell().sidecar("argus").and_then(|c| c.args(["login"]).spawn()) {
        Ok((mut rx, _child)) => {
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = event {
                        log::info!("[argus login] {}", String::from_utf8_lossy(&line).trim_end());
                    }
                }
            });
        }
        Err(err) => log::error!("starting sign-in: {err}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // No Dock icon / no app-switcher entry — this is a menu-bar accessory.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(AppState {
                port: pick_free_port(),
                child: Mutex::new(None),
            });

            let status = MenuItem::with_id(app, "status", "Argus is running", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let signin = MenuItem::with_id(app, "signin", "Sign in…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Argus", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &PredefinedMenuItem::separator(app)?,
                    &open,
                    &start_item,
                    &stop_item,
                    &PredefinedMenuItem::separator(app)?,
                    &signin,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Argus")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => open_dashboard(app),
                    "start" => start(app),
                    "stop" => stop(app),
                    "signin" => sign_in(app),
                    "quit" => {
                        stop(app);
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon).icon_as_template(true);
            }
            tray.build(app)?;

            // Start the background work immediately so the dashboard is live by the time the user
            // clicks "Open dashboard".
            start(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
