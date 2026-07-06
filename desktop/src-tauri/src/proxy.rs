// A dumb TCP reverse proxy binding a fixed "front door" port that the browser/tabs connect to, so
// that port never has to change even though the sidecar's actual port is re-picked on every
// restart. It splices bytes bidirectionally rather than parsing HTTP, so it transparently carries
// whatever the Hono server does (chunked responses, keep-alive, any future SSE/WebSocket upgrade).
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::AppHandle;
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// The holding page shown in place of a proxied response while the backend is unreachable. A
// spinning SVG marks it as actively retrying rather than a dead/frozen page.
const RECONNECTING_BODY: &str = r##"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Argus</title>
<style>
@keyframes argus-spin { to { transform: rotate(360deg); } }
.argus-spinner { animation: argus-spin 1s linear infinite; margin: 0 auto 16px; display: block; }
</style>
</head>
<body style="font-family:sans-serif;color:#888;text-align:center;margin-top:20vh">
<svg class="argus-spinner" width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="12" cy="12" r="10" stroke="#ccc" stroke-width="3" opacity="0.3"></circle>
<path d="M12 2a10 10 0 0 1 10 10" stroke="#888" stroke-width="3" stroke-linecap="round"></path>
</svg>
<p>Reconnecting to Argus&hellip;</p>
<script>
(function poll() {
  setTimeout(function () {
    fetch("/healthz", { cache: "no-store" })
      .then(function (r) { if (r.ok) { location.reload(); } else { poll(); } })
      .catch(function () { poll(); });
  }, 1000);
})();
</script>
</body>
</html>"##;

/// 503 (not 200): a request for /healthz that lands here because the backend is unreachable must
/// read as unhealthy, so the holding page's own poll above (and anything else probing /healthz)
/// can tell "still down" apart from "back up" by status code alone.
///
/// The page polls /healthz itself rather than reloading on a timer: reloading blind re-issues the
/// full page load every second even while the sidecar is still down, which is both wasteful and
/// visibly flashes the page. Polling a cheap endpoint and only reloading once it actually answers
/// keeps the tab quiet (aside from the spinner) until there's really something to show.
///
/// Computed once and cached: the bytes are a constant, so there's no reason to reformat/reallocate
/// them on every failed connection.
static RECONNECTING_RESPONSE: OnceLock<Vec<u8>> = OnceLock::new();

fn reconnecting_response() -> &'static [u8] {
    RECONNECTING_RESPONSE.get_or_init(|| {
        format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            RECONNECTING_BODY.len(),
            RECONNECTING_BODY
        )
        .into_bytes()
    })
}

/// Bind the front-door port and forward every connection to whatever port `backend_port` currently
/// holds. Runs for the life of the app, independent of the sidecar's own start/stop/crash cycle, so
/// a restarting sidecar never orphans an already-open browser tab.
///
/// Tries `preferred_port` first. If something else already holds it, retries once against an
/// OS-assigned free port and updates `front_port` to match — `open_dashboard`/`about_info` read
/// `front_port` live, so they pick up the corrected value — and notifies the user with the actual
/// URL, since a silent fallback would otherwise leave "Open Argus" (and any already-open tab)
/// pointed at a port nothing is listening on.
pub fn start_proxy(
    preferred_port: u16,
    backend_port: Arc<AtomicU16>,
    front_port: Arc<AtomicU16>,
    proxy_ready: Arc<AtomicBool>,
    app: AppHandle,
) {
    tauri::async_runtime::spawn(async move {
        let listener = match bind_front_door(preferred_port).await {
            Ok(BoundPort::Preferred(listener)) => listener,
            Ok(BoundPort::Fallback(listener, actual_port)) => {
                front_port.store(actual_port, Ordering::SeqCst);
                let url = format!("http://localhost:{actual_port}");
                log::warn!("front-door proxy bound to fallback port {actual_port} ({url})");
                crate::notify(
                    &app,
                    "Argus switched ports",
                    &format!("Port {preferred_port} was unavailable. Argus is now at {url}."),
                );
                listener
            }
            Err(err) => {
                log::error!("binding the front-door proxy: {err}");
                crate::notify(
                    &app,
                    "Argus couldn't start",
                    "The browser connection failed to start. Check Console for details.",
                );
                return;
            }
        };
        // The port is bound and `front_port` reflects the real value; the browser can now be opened
        // without racing the bind. Flip readiness before entering the accept loop.
        proxy_ready.store(true, Ordering::SeqCst);
        run_accept_loop(listener, backend_port).await;
    });
}

/// Outcome of [`bind_front_door`]: which port it actually landed on.
enum BoundPort {
    Preferred(TcpListener),
    Fallback(TcpListener, u16),
}

/// Try to bind `preferred_port` first (so the front-door proxy lands on the CLI's familiar default
/// port whenever nothing else is using it); retry once against an OS-assigned free port otherwise.
/// Pure port-picking logic, kept separate from `start_proxy`'s `AppHandle`/notify concerns so it's
/// testable on its own.
async fn bind_front_door(preferred_port: u16) -> io::Result<BoundPort> {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred_port)).await {
        return Ok(BoundPort::Preferred(listener));
    }
    log::warn!(
        "binding the front-door proxy's preferred port {preferred_port} failed; retrying with an OS-assigned port"
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let actual_port = listener.local_addr()?.port();
    Ok(BoundPort::Fallback(listener, actual_port))
}

/// Accept connections forever, forwarding each to whatever port `backend_port` currently holds.
async fn run_accept_loop(listener: TcpListener, backend_port: Arc<AtomicU16>) {
    loop {
        let (inbound, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                log::warn!("accepting a proxy connection: {err}");
                continue;
            }
        };
        let backend_port = backend_port.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = proxy_connection(inbound, backend_port.load(Ordering::SeqCst)).await {
                log::debug!("proxying a connection: {err}");
            }
        });
    }
}

/// Forward one inbound connection to the current backend port. If the backend refuses the
/// connection (sidecar down or mid-restart), hand back a self-reloading holding page instead of a
/// bare connection reset, so an open tab recovers on its own once the sidecar is back up.
async fn proxy_connection(mut inbound: TcpStream, backend_port: u16) -> io::Result<()> {
    let mut outbound = match TcpStream::connect(("127.0.0.1", backend_port)).await {
        Ok(outbound) => outbound,
        Err(err) => {
            serve_holding_page(&mut inbound).await;
            return Err(err);
        }
    };
    io::copy_bidirectional(&mut inbound, &mut outbound).await?;
    Ok(())
}

/// Total time budget for draining the client's request before giving up and closing anyway — a
/// slow or stalled client shouldn't be able to hang the holding-page response indefinitely.
const DRAIN_DEADLINE: Duration = Duration::from_millis(200);

/// Write the holding page and close cleanly. Drains whatever the client already sent first —
/// closing a socket with unread bytes still in the kernel receive buffer sends an RST instead of a
/// clean FIN on most platforms, which would surface to the client as a connection reset rather than
/// the response we just wrote. Loops until the client stops sending (read returns `0`) or the
/// overall deadline elapses, rather than a single bounded read, so a multi-packet request (e.g. a
/// POST body) is still fully drained.
async fn serve_holding_page(inbound: &mut TcpStream) {
    let mut discard = [0u8; 1024];
    let _ = tokio::time::timeout(DRAIN_DEADLINE, async {
        loop {
            match inbound.read(&mut discard).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    })
    .await;
    let _ = inbound.write_all(reconnecting_response()).await;
    let _ = inbound.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::{bind_front_door, run_accept_loop, BoundPort};
    use std::sync::atomic::{AtomicU16, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// A tiny echo server so we can tell which backend actually served a connection.
    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => return,
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    if let Ok(n) = socket.read(&mut buf).await {
                        let _ = socket.write_all(&buf[..n]).await;
                    }
                });
            }
        });
        port
    }

    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn proxy_forwards_to_the_current_backend_port() {
        let backend_a = echo_server().await;
        let backend_b = echo_server().await;
        let backend_port = Arc::new(AtomicU16::new(backend_a));

        let front_port = free_port().await;
        let listener = TcpListener::bind(("127.0.0.1", front_port)).await.unwrap();
        tokio::spawn(run_accept_loop(listener, backend_port.clone()));

        let mut client = TcpStream::connect(("127.0.0.1", front_port)).await.unwrap();
        client.write_all(b"hello-a").await.unwrap();
        let mut buf = [0u8; 16];
        let n = client.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"hello-a");
        drop(client);

        // Flip the backend, as a sidecar restart on a new port would: a *new* connection should
        // land on the new backend, without needing to touch the front port at all.
        backend_port.store(backend_b, Ordering::SeqCst);
        let mut client = TcpStream::connect(("127.0.0.1", front_port)).await.unwrap();
        client.write_all(b"hello-b").await.unwrap();
        let n = client.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"hello-b");
    }

    #[tokio::test]
    async fn proxy_serves_a_holding_page_when_the_backend_is_down() {
        let backend_port = Arc::new(AtomicU16::new(free_port().await)); // nothing listens here
        let front_port = free_port().await;
        let listener = TcpListener::bind(("127.0.0.1", front_port)).await.unwrap();
        tokio::spawn(run_accept_loop(listener, backend_port));

        let mut client = TcpStream::connect(("127.0.0.1", front_port)).await.unwrap();
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(response.contains("Reconnecting"));
        assert!(response.contains("/healthz"));
    }

    #[tokio::test]
    async fn bind_front_door_uses_the_preferred_port_when_free() {
        let preferred = free_port().await;
        match bind_front_door(preferred).await.unwrap() {
            BoundPort::Preferred(listener) => {
                assert_eq!(listener.local_addr().unwrap().port(), preferred);
            }
            BoundPort::Fallback(..) => panic!("expected the preferred port to bind"),
        }
    }

    #[tokio::test]
    async fn bind_front_door_falls_back_when_the_preferred_port_is_taken() {
        // Hold the preferred port open so the real bind attempt fails.
        let held = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let preferred = held.local_addr().unwrap().port();

        match bind_front_door(preferred).await.unwrap() {
            BoundPort::Fallback(listener, actual_port) => {
                assert_ne!(actual_port, preferred);
                assert_eq!(listener.local_addr().unwrap().port(), actual_port);
            }
            BoundPort::Preferred(_) => panic!("expected a fallback port since the preferred one is held"),
        }
    }
}
