import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
// Wire contract from the shared schema package (single source of truth). SCHEMA_VERSION comes
// from the zod-free entry so the CLI doesn't pull zod into its runtime.
import { SCHEMA_VERSION } from "@agentdeploymentco/argus-schema/version";
import type { PushPayload } from "@agentdeploymentco/argus-schema";
export { SCHEMA_VERSION };
export type { PushPayload };

/**
 * Resolve the user id for a snapshot: explicit override wins, else `git config user.email`,
 * else $USER@hostname. Used to tag whose sessions are whose in the team dashboard.
 */
export function detectUser(override?: string): string {
  if (override && override.trim()) return override.trim();
  const git = spawnSync("git", ["config", "user.email"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return process.env.USER || "unknown";
  }
}

/**
 * Resolve the organization: explicit override wins, else the domain of the detected user
 * (e.g. mando@gradient.works -> gradient.works). Returns undefined when it can't be inferred
 * confidently (e.g. a bare --user with no domain) — in that case the payload omits org and the
 * server scopes authoritatively by the token's org. The server always validates any org we send.
 */
export function detectOrg(override: string | undefined, user: string): string | undefined {
  if (override && override.trim()) return override.trim();
  const at = user.lastIndexOf("@");
  if (at >= 0 && at < user.length - 1) return user.slice(at + 1);
  return undefined;
}

export interface PushResult {
  ok: boolean;
  status: number;
  body: string;
}

/** POST a per-user snapshot to the Worker ingest endpoint. */
export async function pushSnapshot(
  endpoint: string,
  token: string,
  payload: PushPayload,
): Promise<PushResult> {
  const url = endpoint.replace(/\/+$/, "") + "/ingest";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
