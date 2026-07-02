// A dumb TCP reverse proxy binding a fixed "front door" port that the browser/tabs connect to, so
// that port never has to change even though the sidecar's actual port is re-picked on every
// restart. It splices bytes bidirectionally rather than parsing HTTP, so it transparently carries
// whatever the Hono server does (chunked responses, keep-alive, any future SSE/WebSocket upgrade).
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const RECONNECTING_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><head><meta charset=\"utf-8\"><title>Argus</title></head><body style=\"font-family:sans-serif;color:#888;text-align:center;margin-top:20vh\"><p>Reconnecting to Argus\xe2\x80\xa6</p><script>setTimeout(() => location.reload(), 1000)</script></body></html>";

/// Bind the fixed front-door port and forward every connection to whatever port `backend_port`
/// currently holds. Runs for the life of the app, independent of the sidecar's own start/stop/crash
/// cycle, so a restarting sidecar never orphans an already-open browser tab.
pub fn start_proxy(front_port: u16, backend_port: Arc<AtomicU16>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", front_port)).await {
            Ok(listener) => listener,
            Err(err) => {
                log::error!("binding the front-door proxy port {front_port}: {err}");
                return;
            }
        };
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
                if let Err(err) = proxy_connection(inbound, backend_port.load(Ordering::SeqCst)).await
                {
                    log::debug!("proxying a connection: {err}");
                }
            });
        }
    });
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

/// Write the holding page and close cleanly. Drains whatever the client already sent first —
/// closing a socket with unread bytes still in the kernel receive buffer sends an RST instead of a
/// clean FIN on most platforms, which would surface to the client as a connection reset rather than
/// the response we just wrote.
async fn serve_holding_page(inbound: &mut TcpStream) {
    let mut discard = [0u8; 1024];
    let _ = tokio::time::timeout(Duration::from_millis(200), inbound.read(&mut discard)).await;
    let _ = inbound.write_all(RECONNECTING_RESPONSE).await;
    let _ = inbound.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::start_proxy;
    use std::sync::atomic::{AtomicU16, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
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
        start_proxy(front_port, backend_port.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;

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
        start_proxy(front_port, backend_port);
        tokio::time::sleep(Duration::from_millis(50)).await;

        let mut client = TcpStream::connect(("127.0.0.1", front_port)).await.unwrap();
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Reconnecting"));
    }
}
