import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These exercise the citty argument layer end-to-end by running the real CLI. citty parses
// non-strictly, so src/cli.ts adds an explicit guard (validateArgs) for unknown flags, value-less
// string flags that would eat the next token, and stray positionals (#59). Each case runs the CLI
// as a subprocess and asserts the exit code and message.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Run the CLI with isolated, empty config/data dirs so it never reads the developer's real store. */
function runCli(args: string[]): { status: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
  const result = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARGUS_DATA_DIR: join(dir, "data"),
      ARGUS_CONFIG_DIR: join(dir, "config"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CODEX_HOME: join(dir, "codex"),
      GEMINI_CLI_HOME: dir,
      NO_COLOR: "1",
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
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
});
