import { describe, expect, test } from "bun:test";
import { skillPlugin } from "../src/reporting/inventory.ts";
import type { PluginInfo } from "../src/types.ts";

const plugins = new Map<string, PluginInfo>([
  ["jj", { name: "jj", marketplace: "tianguis", enabled: true }],
  ["gw-github", { name: "gw-github", marketplace: "dubmart", enabled: true }],
]);

describe("skillPlugin", () => {
  test("maps a plugin:skill attribution to its plugin", () => {
    expect(skillPlugin("jj:jj", plugins)).toBe("jj");
    expect(skillPlugin("gw-github:issues", plugins)).toBe("gw-github");
  });

  test("returns null for bare (builtin/personal) skills and unknown plugins", () => {
    expect(skillPlugin("review", plugins)).toBeNull();
    expect(skillPlugin("init", plugins)).toBeNull();
    expect(skillPlugin("unknown-plugin:thing", plugins)).toBeNull();
  });
});
