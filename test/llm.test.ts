import { beforeEach, describe, expect, test } from "bun:test";
import {
  complete,
  getProvider,
  isLlmProvider,
  LLM_PROVIDERS,
  PROVIDER_API_KEY_ENVS,
  type LlmProvider,
} from "../src/llm/index.ts";
import {
  resolveClaudeBinary,
  runClaudeProvider,
  runCommandProvider,
} from "../src/llm/providers/local.ts";
import {
  buildClaudeSandboxProfile,
  claudeSandboxCommand,
  isClaudeSandboxFailure,
  resetClaudeSandboxState,
} from "../src/llm/providers/claude-sandbox.ts";
import type { ResolvedLlmConfig } from "../src/llm/types.ts";

/** A recording fake fetch that returns scripted responses in order. */
function fakeFetch(responses: Array<Response | (() => Response)>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function silenceStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stderr.write;
  process.stderr.write = ((..._args: unknown[]) => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

const cfg = (over: Partial<ResolvedLlmConfig> & { provider: LlmProvider }): ResolvedLlmConfig => ({
  apiKey: "test-key",
  ...over,
});

describe("resolveClaudeBinary", () => {
  test("an explicit override wins (trimmed), bypassing all probes", () => {
    const probes = { onPath: () => "/from/path", loginShell: () => "/from/shell", knownLocations: () => "/known" };
    expect(resolveClaudeBinary("  /opt/claude/bin/claude  ", probes)).toBe("/opt/claude/bin/claude");
  });

  test("with no override, prefers $PATH, then the login shell, then known locations", () => {
    expect(
      resolveClaudeBinary(undefined, { onPath: () => "/path/claude", loginShell: () => "/shell/claude" }),
    ).toBe("/path/claude");
    expect(
      resolveClaudeBinary(undefined, { onPath: () => undefined, loginShell: () => "/shell/claude" }),
    ).toBe("/shell/claude");
    expect(
      resolveClaudeBinary(undefined, {
        onPath: () => undefined,
        loginShell: () => undefined,
        knownLocations: () => "/usr/local/bin/claude",
      }),
    ).toBe("/usr/local/bin/claude");
  });

  test("falls back to bare \"claude\" when nothing resolves (spawn then surfaces a clear ENOENT)", () => {
    expect(resolveClaudeBinary(undefined, { onPath: () => undefined })).toBe("claude");
  });
});

describe("claude-cli sandbox", () => {
  beforeEach(() => {
    resetClaudeSandboxState();
  });

  const env = { TMPDIR: "/var/folders/zz/argus/T" } as NodeJS.ProcessEnv;
  const sandboxDeps = {
    platform: "darwin",
    sandboxExecPath: "/usr/bin/sandbox-exec",
    homeDir: "/Users/you",
    claudeDir: "/Users/you/.claude",
    tmpDir: "/var/folders/zz/argus/T",
    env,
    isExecutable: (path: string) => path === "/usr/bin/sandbox-exec",
    realpath: (path: string) =>
      path === "/usr/local/bin/claude" ? "/Users/you/.claude/local/claude" : path,
  };

  test("builds a deny-by-default profile with Claude, keychain, and temp access", () => {
    const profile = buildClaudeSandboxProfile({
      claudeBin: "/usr/local/bin/claude",
      realClaudeBin: "/Users/you/.claude/local/claude",
      homeDir: "/Users/you",
      claudeDir: "/Users/you/.claude",
      tmpDir: "/var/folders/zz/argus/T",
      env,
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow file-ioctl\n  (literal "/dev/dtracehelper"))');
    expect(profile).toContain('(literal "/")');
    expect(profile).toContain('(literal "/dev/dtracehelper")');
    expect(profile).toContain('(literal "/Users/you/.claude.json")');
    expect(profile).toContain('(literal "/Users/you/.claude/settings.json")');
    expect(profile).toContain('(literal "/Users/you/Library/Keychains/login.keychain-db")');
    expect(profile).toContain('(literal "/Library/Keychains/System.keychain")');
    expect(profile).toContain('(literal "/Library/Preferences/com.apple.networkd.plist")');
    expect(profile).toContain('(allow file-read-metadata');
    expect(profile).toContain('(literal "/Users")');
    expect(profile).toContain('(literal "/Users/you")');
    expect(profile).toContain('(subpath "/var/folders/zz/argus/T")');
    expect(profile).toContain('(subpath "/private/var/folders")');
    expect(profile).toContain('(subpath "/Users/you/.claude/local")');
    expect(profile).toContain('(subpath "/Users/you/.claude/plugins")');
    expect(profile).toContain('(subpath "/Users/you/.claude/session-env")');
    expect(profile).toContain('(allow file-write* file-write-create');
    expect(profile).not.toContain("/Users/you/.claude/projects");
    expect(profile).not.toContain("/Users/you/.codex");
    expect(profile).not.toContain("/Users/you/code");
  });

  test("clamps process-exec to an allowlist so CLT stubs (git/python3) never pop the install dialog", () => {
    const profile = buildClaudeSandboxProfile({
      claudeBin: "/usr/local/bin/claude",
      realClaudeBin: "/Users/you/.claude/local/claude",
      homeDir: "/Users/you",
      claudeDir: "/Users/you/.claude",
      tmpDir: "/var/folders/zz/argus/T",
      env,
    });

    // No blanket process allow: exec is denied by default and re-allowed only for the allowlist.
    expect(profile).not.toContain("(allow process*)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(deny process-exec)");
    // The allowlist: claude itself (+ realpath) and the mandatory keychain helper — nothing else.
    expect(profile).toContain(
      '(allow process-exec\n' +
        '  (literal "/Users/you/.claude/local/claude")\n' +
        '  (literal "/usr/bin/security")\n' +
        '  (literal "/usr/local/bin/claude"))',
    );
    // The Apple CLT stubs are not on the allowlist, so they stay denied by the blanket rule.
    expect(profile).not.toContain('(literal "/usr/bin/git")');
    expect(profile).not.toContain('(literal "/usr/bin/python3")');
    // The allow must come after the blanket deny so it takes precedence.
    expect(profile.indexOf("(deny process-exec)")).toBeLessThan(
      profile.indexOf("(allow process-exec"),
    );
  });

  test("wraps claude with sandbox-exec on macOS when sandboxing is available", () => {
    const command = claudeSandboxCommand("/usr/local/bin/claude", ["-p", "-"], sandboxDeps);

    expect(command.sandboxed).toBe(true);
    expect(command.file).toBe("/usr/bin/sandbox-exec");
    expect(command.args[0]).toBe("-p");
    expect(command.args[1]).toContain("/Users/you/.claude/local/claude");
    expect(command.args.slice(2)).toEqual(["/usr/local/bin/claude", "-p", "-"]);
  });

  test("missing sandbox-exec logs and runs direct claude", async () => {
    const calls: Array<{ file: string; args: string[]; input: string; cwd: string | undefined }> = [];
    const logs: string[] = [];
    const result = await silenceStderr(() =>
      runClaudeProvider(
        { prompt: "hello", claudeCliPath: "/usr/local/bin/claude", log: (message) => logs.push(message) },
        {
          ...sandboxDeps,
          isExecutable: () => false,
          spawnWithStdin: async (file, args, input, _signal, cwd) => {
            calls.push({ file, args, input, cwd });
            return { ok: true, text: "ok" };
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/usr/local/bin/claude");
    expect(calls[0]!.args).toEqual(["-p", "--no-session-persistence", "--model", "haiku", "-"]);
    expect(calls[0]!.cwd).toBe("/var/folders/zz/argus/T");
    expect(logs.join("\n")).toContain("sandbox unavailable");
  });

  test("sandbox failures log and retry direct claude", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const logs: string[] = [];
    const runtime = {
      ...sandboxDeps,
      spawnWithStdin: async (file: string, args: string[]) => {
        calls.push({ file, args });
        if (file === "/usr/bin/sandbox-exec") {
          return { ok: false, text: "", error: "exited with status null", status: null };
        }
        return { ok: true, text: "ok" };
      },
    };
    const result = await silenceStderr(() =>
      runClaudeProvider(
        { prompt: "hello", claudeCliPath: "/usr/local/bin/claude", log: (message) => logs.push(message) },
        runtime,
      ),
    );
    const second = await silenceStderr(() =>
      runClaudeProvider(
        { prompt: "hello again", claudeCliPath: "/usr/local/bin/claude", log: (message) => logs.push(message) },
        runtime,
      ),
    );

    expect(result.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls.map((call) => call.file)).toEqual([
      "/usr/bin/sandbox-exec",
      "/usr/local/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(logs.join("\n")).toContain("retrying without sandbox");
    expect(logs.join("\n").match(/retrying without sandbox/g)).toHaveLength(1);
  });

  test("an app-level Claude failure surfaces without an unsandboxed retry", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const runtime = {
      ...sandboxDeps,
      // A genuine app-level failure (not a sandbox denial): a non-zero exit with a real message.
      spawnWithStdin: async (file: string) => {
        calls.push(file);
        return file === "/usr/bin/sandbox-exec"
          ? { ok: false, text: "", error: "Not logged in", status: 1 }
          : { ok: true, text: "ok" };
      },
    };
    const result = await silenceStderr(() =>
      runClaudeProvider(
        { prompt: "hello", claudeCliPath: "/usr/local/bin/claude", log: (message) => logs.push(message) },
        runtime,
      ),
    );

    // The failure is not a sandbox failure, so we don't retry unsandboxed or disable the sandbox.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not logged in");
    expect(calls).toEqual(["/usr/bin/sandbox-exec"]);
    expect(logs.join("\n")).not.toContain("retrying without sandbox");

    // The latch is untouched: a later call still attempts the sandbox.
    const second = await silenceStderr(() =>
      runClaudeProvider(
        { prompt: "again", claudeCliPath: "/usr/local/bin/claude", log: (message) => logs.push(message) },
        runtime,
      ),
    );
    expect(calls).toEqual(["/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec"]);
    expect(second.ok).toBe(false);
  });

  test("isClaudeSandboxFailure distinguishes sandbox denials from app failures", () => {
    // An app-level failure with a real message is not a sandbox failure.
    expect(isClaudeSandboxFailure({ ok: false, text: "", error: "Not logged in", status: 1 })).toBe(false);
    // An opaque failure (killed with no output, or a bare non-zero exit with no stderr) is treated as one.
    expect(isClaudeSandboxFailure({ ok: false, text: "", error: "exited with status null", status: null })).toBe(true);
    expect(isClaudeSandboxFailure({ ok: false, text: "", error: "exited with status 1", status: 1 })).toBe(true);
  });
});

describe("local provider stdin (#154 review)", () => {
  test("a child that exits before draining a large prompt fails cleanly, never crashing the process", async () => {
    // `false` exits immediately without reading stdin; a multi-MB prompt makes the write outlive the
    // child, so the stdin pipe emits EPIPE. Without the stdin 'error' listener that's an unhandled
    // error that takes down the whole process; with it, we just get a clean failure result.
    const huge = "x".repeat(8 * 1024 * 1024);
    const result = await runCommandProvider({ prompt: huge, command: "false" });
    expect(result.ok).toBe(false);
  });

  test("surfaces a failing command's stdout when it exits non-zero with empty stderr", async () => {
    // The `claude -p` failure behind the "exited with status 1" report: the CLI writes its diagnostic
    // (e.g. "Not logged in · Please run /login") to stdout, not stderr, then exits 1. The error must be
    // that message, not a bare "exited with status 1".
    const result = await runCommandProvider({
      prompt: "ping",
      command: `sh -c 'echo "Not logged in · Please run /login"; exit 1'`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not logged in · Please run /login");
    expect(result.status).toBe(1);
  });

  test("falls back to the bare status only when both streams are empty", async () => {
    const result = await runCommandProvider({ prompt: "ping", command: "false" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("exited with status 1");
  });

  test("prefers stderr over stdout for the failure reason", async () => {
    const result = await runCommandProvider({
      prompt: "ping",
      command: `sh -c 'echo stdout-msg; echo stderr-msg 1>&2; exit 2'`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stderr-msg");
  });
});

describe("provider registry (single source of truth)", () => {
  test("every provider name resolves to its descriptor; unknown → undefined", () => {
    for (const name of LLM_PROVIDERS) expect(getProvider(name)?.name).toBe(name);
    expect(getProvider("nope")).toBeUndefined();
    expect(isLlmProvider("claude-api")).toBe(true);
    expect(isLlmProvider("nope")).toBe(false);
  });

  test("the secret allowlist + key requirement derive from descriptors", () => {
    expect([...PROVIDER_API_KEY_ENVS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(getProvider("claude-api")?.requiresApiKey).toBe(true);
    expect(getProvider("claude-cli")?.requiresApiKey).toBeUndefined();
  });

  test("an unknown provider → ok:false, never throws", async () => {
    const res = await complete({ prompt: "x" }, { provider: "bogus" as LlmProvider });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown");
  });
});

describe("llm client routing", () => {
  test("off → ok:false with a clear reason, no fetch", async () => {
    const { fetch, calls } = fakeFetch([json({})]);
    const res = await complete({ prompt: "hi" }, cfg({ provider: "off" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No LLM provider");
    expect(calls).toHaveLength(0);
  });

  test("hub → not implemented", async () => {
    const res = await complete({ prompt: "hi" }, cfg({ provider: "hub" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("hub");
  });

  test("http provider with no key → diagnostic naming the env var", async () => {
    const res = await complete(
      { prompt: "hi" },
      { provider: "claude-api", apiKeyEnv: "ANTHROPIC_API_KEY" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ANTHROPIC_API_KEY");
  });
});

describe("anthropic provider", () => {
  test("shapes the request and extracts text", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "hello world" }] })]);
    const res = await complete(
      { prompt: "the data", system: "be brief", maxTokens: 99 },
      cfg({ provider: "claude-api", model: "claude-haiku-4-5" }),
      { fetch },
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe("hello world");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 99,
      system: "be brief",
      messages: [{ role: "user", content: "the data" }],
    });
  });

  test("uses the default model when unset", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "x" }] })]);
    await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe("claude-haiku-4-5");
  });

  test("a configured maxTokens of 0 clamps to the default (never sends max_tokens: 0)", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "x" }] })]);
    await complete({ prompt: "p" }, cfg({ provider: "claude-api", maxTokens: 0 }), { fetch });
    expect(JSON.parse(calls[0]!.init.body as string).max_tokens).toBe(2048);
  });
});

describe("openai provider", () => {
  test("default base url, bearer auth, choices extraction", async () => {
    const { fetch, calls } = fakeFetch([
      json({ choices: [{ message: { content: "answer" } }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "openai", model: "gpt-5" }), { fetch });
    expect(res.text).toBe("answer");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    // Native OpenAI: newer models require max_completion_tokens, not the (rejected) max_tokens.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
  });

  test("honors a custom baseUrl (trailing slash trimmed); still native max_completion_tokens", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [{ message: { content: "ok" } }] })]);
    await complete(
      { prompt: "p" },
      cfg({ provider: "openai", baseUrl: "http://localhost:1234/v1/" }),
      { fetch },
    );
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    // The native openai provider uses the modern field regardless of base URL.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("openrouter provider", () => {
  test("reuses the OpenAI transport against OpenRouter's base url (classic max_tokens)", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [{ message: { content: "via openrouter" } }] })]);
    const res = await complete(
      { prompt: "p" },
      cfg({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" }),
      { fetch },
    );
    expect(res.text).toBe("via openrouter");
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    // OpenRouter is OpenAI-compatible (not api.openai.com) → classic max_tokens.
    expect(body.max_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("gemini provider", () => {
  test("model in the path, x-goog-api-key, parts extraction", async () => {
    const { fetch, calls } = fakeFetch([
      json({ candidates: [{ content: { parts: [{ text: "g1" }, { text: "g2" }] } }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "gemini", model: "gemini-2.5-flash" }), { fetch });
    expect(res.text).toBe("g1g2");
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });
});

describe("error and retry paths", () => {
  test("retries on 429 then succeeds", async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      () => json({ content: [{ type: "text", text: "after retry" }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("after retry");
    expect(calls).toHaveLength(2);
  });

  test("gives up after repeated 5xx", async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response("boom", { status: 503, headers: { "retry-after": "0" } }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(calls.length).toBe(3); // maxAttempts
  });

  test("does not retry a 401", async () => {
    const { fetch, calls } = fakeFetch([() => new Response("nope", { status: 401 })]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("malformed JSON body → ok:false", async () => {
    const { fetch } = fakeFetch([
      () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid JSON");
  });

  test("oversized response (declared content-length) → ok:false", async () => {
    const { fetch } = fakeFetch([
      () =>
        json(
          { content: [{ type: "text", text: "x" }] },
          { headers: { "content-type": "application/json", "content-length": String(40 * 1024 * 1024) } },
        ),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("size limit");
  });

  test("oversized response (undeclared, streamed) → ok:false without buffering it all", async () => {
    // A 1 MB chunk emitted repeatedly past the 32 MB cap, with NO content-length so the pre-check
    // can't catch it. The streaming reader must stop and cancel rather than buffer the whole body.
    const chunk = new Uint8Array(1024 * 1024); // 1 MB
    let emitted = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted > 64 * 1024 * 1024) {
          controller.close();
          return;
        }
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = fakeFetch([
      () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("size limit");
    expect(cancelled).toBe(true);
    // Stopped near the cap, not after draining the full 64 MB the stream would have produced.
    expect(emitted).toBeLessThan(40 * 1024 * 1024);
  });
});
