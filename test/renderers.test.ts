import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { aggregate } from "../src/aggregate.ts";
import { parseAll } from "../src/parse.ts";
import { RENDERERS } from "../src/renderers.ts";
import type { PluginInfo } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");

function dashboard() {
  const parsed = parseAll({
    projectsDir: join(FIX, "projects"),
    historyFile: join(FIX, "history.jsonl"),
  });
  return aggregate(parsed, new Map<string, PluginInfo>(), new Map());
}

describe("RENDERERS", () => {
  test("each format produces non-empty output; console routes to stdout", () => {
    const dash = dashboard();

    const html = RENDERERS.html(dash);
    expect(html.toStdout).toBe(false);
    expect(html.content).toContain("<!doctype html>");

    const json = RENDERERS.json(dash);
    expect(json.toStdout).toBe(false);
    expect(JSON.parse(json.content).totals.sessions).toBe(dash.totals.sessions);

    const console = RENDERERS.console(dash);
    expect(console.toStdout).toBe(true);
    expect(console.content.length).toBeGreaterThan(0);
  });
});
