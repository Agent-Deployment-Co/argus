import { describe, expect, test } from "bun:test";
import { resolveShebangSandbox } from "../src/llm/providers/shebang.ts";

const homebrewClaude = "/opt/homebrew/bin/claude";
const homebrewClaudeRealpath = "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js";
const homebrewNode = "/opt/homebrew/bin/node";
const homebrewNodeRealpath = "/opt/homebrew/Cellar/node/26.0.0/bin/node";

const realpath = (path: string) => {
  if (path === homebrewClaude) return homebrewClaudeRealpath;
  if (path === homebrewNode) return homebrewNodeRealpath;
  return path;
};

describe("resolveShebangSandbox", () => {
  test("returns no extra sandbox paths for native binaries", () => {
    const resolution = resolveShebangSandbox({
      paths: ["/Users/you/.claude/local/claude"],
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      canExecute: () => false,
      realpath,
      readFilePrefix: () => "\xcf\xfa\xed\xfe",
    });

    expect(resolution).toEqual({ processExecPaths: [] });
  });

  test("resolves a Homebrew-style env node wrapper even when PATH is minimal", () => {
    const resolution = resolveShebangSandbox({
      paths: [homebrewClaude, homebrewClaudeRealpath],
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      canExecute: (path) => path === homebrewNode,
      realpath,
      readFilePrefix: (path) =>
        path === homebrewClaude || path === homebrewClaudeRealpath
          ? "#!/usr/bin/env node\n"
          : undefined,
    });

    expect(resolution).toEqual({
      processExecPaths: [
        homebrewNodeRealpath,
        homebrewNode,
        "/usr/bin/env",
      ].sort(),
      launchFile: homebrewNode,
      launchArgsPrefix: [homebrewClaude],
    });
  });

  test("honors PATH order before falling back to the wrapper directory", () => {
    const customNode = "/Users/you/bin/node";
    const resolution = resolveShebangSandbox({
      paths: [homebrewClaude],
      env: { PATH: "/Users/you/bin:/usr/bin" } as NodeJS.ProcessEnv,
      canExecute: (path) => path === customNode || path === homebrewNode,
      realpath,
      readFilePrefix: () => "#!/usr/bin/env node\n",
    });

    expect(resolution.launchFile).toBe(customNode);
    expect(resolution.launchArgsPrefix).toEqual([homebrewClaude]);
    expect(resolution.processExecPaths).toContain(customNode);
    expect(resolution.processExecPaths).not.toContain(homebrewNode);
  });

  test("allows direct shebang interpreters without rewriting the launch command", () => {
    const resolution = resolveShebangSandbox({
      paths: ["/opt/tools/cli"],
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      canExecute: () => false,
      realpath: (path) => path === "/opt/runtime/bin/tool" ? "/opt/runtime/versions/1/bin/tool" : path,
      readFilePrefix: () => "#!/opt/runtime/bin/tool --quiet\n",
    });

    expect(resolution).toEqual({
      processExecPaths: [
        "/opt/runtime/bin/tool",
        "/opt/runtime/versions/1/bin/tool",
      ].sort(),
    });
  });

  test("parses /usr/bin/env -S shebangs", () => {
    const resolution = resolveShebangSandbox({
      paths: [homebrewClaude],
      env: { PATH: "/opt/homebrew/bin:/usr/bin" } as NodeJS.ProcessEnv,
      canExecute: (path) => path === homebrewNode,
      realpath,
      readFilePrefix: () => "#!/usr/bin/env -S node --no-warnings\n",
    });

    expect(resolution.launchFile).toBe(homebrewNode);
    expect(resolution.launchArgsPrefix).toEqual([homebrewClaude]);
    expect(resolution.processExecPaths).toContain(homebrewNode);
    expect(resolution.processExecPaths).toContain(homebrewNodeRealpath);
    expect(resolution.processExecPaths).toContain("/usr/bin/env");
  });
});
