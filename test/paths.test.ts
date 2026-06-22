import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultArgusDataDir, defaultArgusConfigDir } from "../src/paths.ts";

// `defaultArgusDataDir`/`defaultArgusConfigDir` take an injectable env + platform so the resolution
// chain can be exercised without mutating the real process environment. The order under test:
//   explicit ARGUS_DATA_DIR/ARGUS_CONFIG_DIR  >  ARGUS_HOME  >  XDG/platform defaults

describe("location resolution (#79)", () => {
  test("ARGUS_HOME places data under /data and config under /config", () => {
    const env = { ARGUS_HOME: "/tmp/argus" };
    expect(defaultArgusDataDir(env, "linux")).toBe(join("/tmp/argus", "data"));
    expect(defaultArgusConfigDir(env, "linux")).toBe(join("/tmp/argus", "config"));
  });

  test("explicit ARGUS_DATA_DIR / ARGUS_CONFIG_DIR win over ARGUS_HOME", () => {
    const env = {
      ARGUS_HOME: "/tmp/argus",
      ARGUS_DATA_DIR: "/mnt/data",
      ARGUS_CONFIG_DIR: "/etc/argus",
    };
    expect(defaultArgusDataDir(env, "linux")).toBe("/mnt/data");
    expect(defaultArgusConfigDir(env, "linux")).toBe("/etc/argus");
  });

  test("empty ARGUS_HOME counts as absent and falls through", () => {
    const env = { ARGUS_HOME: "", XDG_DATA_HOME: "/xdg/data", XDG_CONFIG_HOME: "/xdg/config" };
    expect(defaultArgusDataDir(env, "linux")).toBe(join("/xdg/data", "argus"));
    expect(defaultArgusConfigDir(env, "linux")).toBe(join("/xdg/config", "argus"));
  });

  test("no vars set → XDG when present", () => {
    const env = { XDG_DATA_HOME: "/xdg/data", XDG_CONFIG_HOME: "/xdg/config" };
    expect(defaultArgusDataDir(env, "linux")).toBe(join("/xdg/data", "argus"));
    expect(defaultArgusConfigDir(env, "linux")).toBe(join("/xdg/config", "argus"));
  });

  test("no vars set → macOS Application Support default (unchanged)", () => {
    const env = {};
    const mac = join(homedir(), "Library", "Application Support", "argus");
    expect(defaultArgusDataDir(env, "darwin")).toBe(mac);
    expect(defaultArgusConfigDir(env, "darwin")).toBe(mac);
  });

  test("no vars set → Linux fallback default (unchanged)", () => {
    const env = {};
    expect(defaultArgusDataDir(env, "linux")).toBe(join(homedir(), ".local", "share", "argus"));
    expect(defaultArgusConfigDir(env, "linux")).toBe(join(homedir(), ".config", "argus"));
  });
});
