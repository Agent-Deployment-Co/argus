import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These exercise the citty argument layer end-to-end by running the real CLI. citty parses
// non-strictly, so src/cli.ts adds an explicit guard (validateArgs) for unknown flags, value-less
// string flags that would eat the next token, and stray positionals (#59). Each case runs the CLI
// as a subprocess and asserts the exit code and message.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

/** Run the CLI with isolated, empty config/data dirs so it never reads the developer's real store. */
function cliEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    ARGUS_DATA_DIR: join(dir, "data"),
    ARGUS_CONFIG_DIR: join(dir, "config"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    CODEX_HOME: join(dir, "codex"),
    GEMINI_CLI_HOME: dir,
    NO_COLOR: "1",
  };
}

function runCli(args: string[], dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"))): { status: number; stderr: string; stdout: string } {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(dir),
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/** The isolated env every CLI subprocess runs under, so tests never touch the developer's store. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
  return {
    ...process.env,
    ARGUS_DATA_DIR: join(dir, "data"),
    ARGUS_CONFIG_DIR: join(dir, "config"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    CODEX_HOME: join(dir, "codex"),
    GEMINI_CLI_HOME: dir,
    NO_COLOR: "1",
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("cli argument validation", () => {
  test("report rejects an unknown flag instead of silently ignoring it", () => {
    const { status, stderr } = runCli(["report", "--opne", "--console"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option: --opne");
  });

  test("serve rejects an unknown flag", () => {
    const { status, stderr } = runCli(["serve", "--bogus"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option: --bogus");
  });

  test("a value-less string flag does not eat the following flag", () => {
    // `--since` has no value, so citty would otherwise parse since="--out" and drop the real --out.
    const { status, stderr } = runCli(["report", "--since", "--out", "foo.html"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Missing value for --since");
  });

  test("a command that takes no positionals rejects a stray argument", () => {
    const { status, stderr } = runCli(["report", "extra"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unexpected argument: extra");
  });

  test("valid flags (including --source, --no-agentsview, -o) are accepted", () => {
    // Runs against the isolated empty store, so it should complete cleanly without an arg error.
    const { status, stderr } = runCli([
      "report",
      "--source",
      "claude",
      "--no-agentsview",
      "--since",
      "2026-01-01",
      "--console",
    ]);
    expect(status).toBe(0);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain("Missing value");
    expect(stderr).not.toContain("Unexpected argument");
  });

  test("facts prints Codex task facts for a synced session", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
    cpSync(join(FIXTURES, "codex-sessions"), join(dir, "codex", "sessions"), {
      recursive: true,
    });
    const extractor = join(dir, "task-extractor.js");
    writeFileSync(
      extractor,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ tasks: [{ description: "extracted fixture task", messageIndexes: [0] }] }));
});`,
    );
    chmodSync(extractor, 0o755);
    const command = `"${process.execPath}" "${extractor}"`;

    const synced = runCli(["index", "--source", "codex", "--no-agentsview"], dir);
    expect(synced.status).toBe(0);

    const before = runCli(["facts", "codex:codex-sess1"], dir);
    expect(before.status).toBe(0);
    expect(before.stderr).toContain("No tasks found for codex:codex-sess1");

    const facts = runCli([
      "facts",
      "codex:codex-sess1",
      "--extract",
      "--task-provider",
      "command",
      "--task-command",
      command,
    ], dir);
    expect(facts.status).toBe(0);
    expect(facts.stderr).toContain("Saved 1 task for codex:codex-sess1");
    expect(facts.stdout).toContain("Tasks for codex:codex-sess1");
    expect(facts.stdout).toContain("extracted fixture task");
    expect(facts.stdout).not.toContain("codex hello");
  });

  test("facts extracts task facts for a synced Claude session", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
    cpSync(join(FIXTURES, "projects"), join(dir, "claude", "projects"), {
      recursive: true,
    });
    const extractor = join(dir, "task-extractor.js");
    writeFileSync(
      extractor,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ tasks: [{ description: "extracted claude task", messageIndexes: [0] }] }));
});`,
    );
    chmodSync(extractor, 0o755);
    const command = `"${process.execPath}" "${extractor}"`;

    const synced = runCli(["index", "--source", "claude", "--no-agentsview"], dir);
    expect(synced.status).toBe(0);

    const facts = runCli([
      "facts",
      "sess1",
      "--extract",
      "--task-provider",
      "command",
      "--task-command",
      command,
    ], dir);
    expect(facts.status).toBe(0);
    expect(facts.stderr).toContain("Saved 1 task for sess1");
    expect(facts.stdout).toContain("Tasks for sess1");
    expect(facts.stdout).toContain("extracted claude task");
    expect(facts.stdout).not.toContain("hello there");
  });

  test("facts extracts task facts for a synced Gemini session", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
    cpSync(join(FIXTURES, "gemini"), join(dir, ".gemini"), {
      recursive: true,
    });
    const extractor = join(dir, "task-extractor.js");
    writeFileSync(
      extractor,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ tasks: [{ description: "extracted gemini task", messageIndexes: [0, 1] }] }));
});`,
    );
    chmodSync(extractor, 0o755);
    const command = `"${process.execPath}" "${extractor}"`;

    const synced = runCli(["index", "--source", "gemini", "--no-agentsview"], dir);
    expect(synced.status).toBe(0);

    const facts = runCli([
      "facts",
      "gemini:gemini-main",
      "--extract",
      "--task-provider",
      "command",
      "--task-command",
      command,
    ], dir);
    expect(facts.status).toBe(0);
    expect(facts.stderr).toContain("Saved 1 task for gemini:gemini-main");
    expect(facts.stdout).toContain("Tasks for gemini:gemini-main");
    expect(facts.stdout).toContain("extracted gemini task");
    expect(facts.stdout).not.toContain("gemini hello");
  });

  test("facts extracts task facts for a synced Cowork session", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
    cpSync(
      join(FIXTURES, "cowork-sessions"),
      join(dir, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
      { recursive: true },
    );
    const extractor = join(dir, "task-extractor.js");
    writeFileSync(
      extractor,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ tasks: [{ description: "extracted cowork task", messageIndexes: [0, 1] }] }));
});`,
    );
    chmodSync(extractor, 0o755);
    const command = `"${process.execPath}" "${extractor}"`;

    const synced = runCli(["index", "--source", "cowork", "--no-agentsview"], dir);
    expect(synced.status).toBe(0);

    const facts = runCli([
      "facts",
      "cowork:inner-session-id-111",
      "--extract",
      "--task-provider",
      "command",
      "--task-command",
      command,
    ], dir);
    expect(facts.status).toBe(0);
    expect(facts.stderr).toContain("Saved 1 task for cowork:inner-session-id-111");
    expect(facts.stdout).toContain("Tasks for cowork:inner-session-id-111");
    expect(facts.stdout).toContain("extracted cowork task");
    expect(facts.stdout).not.toContain("Do something");
  });
});

describe("index command group", () => {
  test("bare `index` performs an incremental read against the empty store", () => {
    const { status, stderr } = runCli(["index", "--source", "claude", "--no-agentsview"]);
    expect(status).toBe(0);
    expect(stderr).toContain("Local store now has");
  });

  test("`index delete` with no ids prints usage without removing anything", () => {
    const { status, stderr } = runCli(["index", "delete"]);
    expect(status).toBe(0);
    expect(stderr).toContain("argus index delete <session-id>");
    expect(stderr).not.toContain("Unexpected argument");
  });

  test("`index rebuild` without --force refuses on a non-interactive stdin", () => {
    const { status, stderr } = runCli(["index", "rebuild"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--force");
  });
});

describe("removed verbs", () => {
  for (const verb of ["push", "reindex", "forget", "sync"]) {
    test(`\`${verb}\` is gone (or repurposed) — old indexing/push aliases are not silently accepted`, () => {
      const { status, stderr } = runCli([verb, "--bogus-flag-xyz"]);
      // `sync` now exists (upload) and rejects the unknown flag (exit 2); the others are unknown
      // commands. Either way the old local-indexing/push behavior is not silently reachable.
      expect(status).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
    });
  }

  test("`reindex` reports an unknown command", () => {
    const { stderr } = runCli(["reindex"]);
    expect(stderr).toContain("Unknown command");
  });
});

describe("run command", () => {
  test("--help lists the orchestrator flags", () => {
    const { status, stdout, stderr } = runCli(["run", "--help"]);
    const out = stdout + stderr;
    expect(status).toBe(0);
    expect(out).toContain("index-interval");
    expect(out).toContain("sync-interval");
  });

  test("starts all legs and shuts down cleanly on SIGTERM", async () => {
    const port = await freePort();
    const child = spawn("bun", ["run", CLI, "run", "--source", "claude", "--no-agentsview", "--port", String(port)], {
      env: isolatedEnv(),
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
    const deadline = Date.now() + 15_000;
    while (!stderr.includes("Listening on") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stderr).toContain("Listening on");

    child.kill("SIGTERM");
    const code = await exited;
    expect(code).toBe(0);
    expect(stderr).toContain("Shutting down");
  }, 25_000);
});

describe("serve command", () => {
  test("exits nonzero when the requested port is already in use", async () => {
    // Occupy a port, then ask `serve` to bind the same one. A failed start must not look like success.
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
    const addr = occupied.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const { status, stderr } = runCli(["serve", "--port", String(port)]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("web server");
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
