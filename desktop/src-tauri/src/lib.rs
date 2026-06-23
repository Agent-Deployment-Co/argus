// Argus tray app: a thin native shell around the `argus` sidecar.
//
// It creates no window. On launch it starts `argus run` (index + serve + sync, supervised in one
// process) on a free local port and exposes a tray menu whose items map onto the CLI's command
// surface. "Open dashboard" opens the user's default browser at the served URL — the dashboard is
// the existing web app, not an embedded webview.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
    let _ = state
        .status_item
        .set_text(if running { "Argus is running" } else { "Argus is stopped" });
    let _ = state.open_item.set_enabled(running);
    let _ = state.start_item.set_enabled(!running);
    let _ = state.stop_item.set_enabled(running);
}

/// Spawn `argus run --port <port>` as a sidecar, forwarding the web-asset location, and drain its
/// output to the log. When it exits (crash or stop), clear the handle and refresh the menu so the
/// tray never claims to be running a process that has gone away.
fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
    let port = app.state::<AppState>().port;
    let mut command = app
        .shell()
        .sidecar("argus")
        .map_err(|e| format!("locating the argus sidecar: {e}"))?
        .args(["run", "--port", &port.to_string(), "--no-sync"]);
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

/// Kick off the browser sign-in flow (`argus login`, Cloudflare Access). Fire-and-forget: it opens
/// a browser and exits; the running sidecar's sync leg recovers from dormant once a token lands.
fn sign_in(app: &AppHandle) {
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

/// Toggle launch-at-login and return the new state so the menu checkmark can follow.
fn toggle_autostart(app: &AppHandle) -> bool {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled { manager.disable() } else { manager.enable() };
    match result {
        Ok(()) => !enabled,
        Err(err) => {
            log::error!("toggling open-at-login: {err}");
            enabled
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
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

            let status = MenuItem::with_id(app, "status", "Argus is starting…", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let signin = MenuItem::with_id(app, "signin", "Sign in…", true, None::<&str>)?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Open at login",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit Argus", true, None::<&str>)?;
            let build_id = MenuItem::with_id(
                app,
                "build",
                &format!("Build {}", env!("ARGUS_BUILD_ID")),
                false,
                None::<&str>,
            )?;
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
                    &autostart,
                    &PredefinedMenuItem::separator(app)?,
                    &build_id,
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
                    "signin" => sign_in(app),
                    "autostart" => {
                        let _ = toggle_autostart(app);
                    }
                    "quit" => {
                        stop(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Start the background work immediately so the dashboard is live by the time the user
            // clicks "Open dashboard".
            start(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
