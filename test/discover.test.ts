import { describe, expect, test } from "bun:test";
import { projectLabel } from "../src/indexing/discover.ts";

describe("projectLabel", () => {
  test("uses the last two path segments", () => {
    expect(projectLabel("/Users/mando/code/gw/webapp")).toBe("gw/webapp");
    expect(projectLabel("")).toBe("(unknown)");
  });
});
