import type { Context } from "hono";
import { isLoopbackHost } from "../config.ts";

/** The Node adapter puts the IncomingMessage on the Hono environment. Tests and non-Node adapters
 *  may omit it, so the request helpers fall back to the Host header in that case. */
type NodeRequestEnv = {
  incoming?: { socket?: { remoteAddress?: string } };
};

/** Strip the :port suffix from a Host header. Bracketed IPv6 hosts keep their brackets so they can
 *  be compared with the same loopback forms the HTTP layer accepts. */
export function hostWithoutPort(host: string): string {
  const bracketed = host.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  // A bare IPv6 literal contains multiple colons and carries no port.
  if (host.indexOf(":") !== host.lastIndexOf(":")) return host;
  return host.replace(/:\d+$/, "");
}

/** Return the address of the TCP peer when the Node adapter supplied one. */
export function requestPeerAddress(c: Context): string | undefined {
  const env = c.env as NodeRequestEnv | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

/** Check the actual peer address, including IPv4-mapped IPv6 loopback addresses. */
export function isLoopbackPeer(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return isLoopbackHost(normalized);
}

/** Whether this request came from the local machine. The Host fallback keeps Hono unit tests and
 *  non-Node adapters deterministic; the production Node server always has a peer address. */
export function requestIsLoopback(c: Context): boolean {
  const peer = requestPeerAddress(c);
  if (peer !== undefined) return isLoopbackPeer(peer);
  return isLoopbackHost(hostWithoutPort(c.req.header("host") ?? ""));
}
