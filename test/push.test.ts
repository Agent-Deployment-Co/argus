import { describe, expect, test } from "bun:test";
import { detectOrg } from "../src/push.ts";

describe("detectOrg", () => {
  test("explicit override wins", () => {
    expect(detectOrg("acme.test", "mando@gradient.works")).toBe("acme.test");
    expect(detectOrg("  spaced  ", "x")).toBe("spaced");
  });

  test("derives org from the email domain when no override", () => {
    expect(detectOrg(undefined, "mando@gradient.works")).toBe("gradient.works");
  });

  test("returns undefined for a bare user (org then comes from the token server-side)", () => {
    expect(detectOrg(undefined, "bob")).toBeUndefined();
    expect(detectOrg(undefined, "trailing@")).toBeUndefined();
  });
});
