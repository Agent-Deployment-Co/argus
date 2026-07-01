import { describe, expect, test } from "bun:test";
import { sanitizeProviderText } from "../src/indexing/interpret/sanitize-paths.ts";

describe("sanitizeProviderText", () => {
  test("keeps non-file absolute routes intact", () => {
    expect(
      sanitizeProviderText("fix /api/sessions and /docs/task-interpretation.md"),
    ).toBe("fix /api/sessions and /docs/task-interpretation.md");
  });

  test("redacts home-relative and absolute local paths", () => {
    // Unlisted extension → caught by the general home-path rule, which stops at whitespace.
    expect(sanitizeProviderText("cat ~/.config/app/settings.conf")).toBe(
      "cat [local file path]",
    );
    expect(sanitizeProviderText("see /Users/you/Desktop/notes.txt please")).toBe(
      "see [local file path] please",
    );
  });

  test("redacts Music and Movie media-library bundles, spaces and all", () => {
    // Default library names contain a space, so the whitespace-stopping home-path rule can't cover
    // them — only the extension rule (which lists these bundle types) redacts the whole path.
    expect(
      sanitizeProviderText("open ~/Music/Music/Music Library.musiclibrary now"),
    ).toBe("open [local file path] now");
    expect(
      sanitizeProviderText("import ~/Movies/iMovie Library.imovielibrary here"),
    ).toBe("import [local file path] here");
    expect(sanitizeProviderText("/Users/you/Movies/TV/Media.tvlibrary")).toBe(
      "[local file path]",
    );
    expect(
      sanitizeProviderText("~/Pictures/Photos Library.photoslibrary"),
    ).toBe("[local file path]");
  });

  test("redacts spaced paths when escaped or quoted", () => {
    // Shell-style backslash-escaped space stays part of the path.
    expect(
      sanitizeProviderText("cd /Users/you/My\\ Projects/client then build"),
    ).toBe("cd [local file path] then build");
    // Quoted paths: the quote terminates the path, so the whole thing is redacted.
    expect(sanitizeProviderText('open "/Users/you/My Docs/report" now')).toBe(
      "open [local file path] now",
    );
    expect(sanitizeProviderText("see '~/My Stuff/notes' here")).toBe(
      "see [local file path] here",
    );
    // Known limitation: a bare, unquoted, extension-less spaced path only redacts up to the space.
    expect(sanitizeProviderText("in ~/My Projects/client dir")).toBe(
      "in [local file path] Projects/client dir",
    );
  });

  test("redacts additional system roots (/mnt, /media, /root)", () => {
    expect(sanitizeProviderText("grab /mnt/d/work/notes.txt here")).toBe(
      "grab [local file path] here",
    );
    expect(sanitizeProviderText("cat /root/.ssh/id_rsa")).toBe(
      "cat [local file path]",
    );
    expect(sanitizeProviderText("/media/you/USB/backup.zip")).toBe(
      "[local file path]",
    );
  });

  test("redacts spaced document names via the broadened extension list", () => {
    expect(
      sanitizeProviderText("open ~/Documents/Q3 Client Report.xlsx now"),
    ).toBe("open [local file path] now");
    expect(sanitizeProviderText("read /Users/you/Notes/API Keys.env")).toBe(
      "read [local file path]",
    );
  });

  test("leaves URL and host paths intact (root not at a boundary)", () => {
    // These look like paths but sit right after a hostname — not local filesystem references.
    expect(
      sanitizeProviderText("see https://example.com/home/dashboard please"),
    ).toBe("see https://example.com/home/dashboard please");
    expect(sanitizeProviderText("logo https://acme.io/media/logo.png here")).toBe(
      "logo https://acme.io/media/logo.png here",
    );
  });

  test("redacts file:// URLs", () => {
    expect(sanitizeProviderText("at file:///Users/you/x.png now")).toBe(
      "at [local file path] now",
    );
  });

  test("redacts Windows paths", () => {
    expect(sanitizeProviderText("open C:\\Users\\you\\notes.txt")).toBe(
      "open [local file path]",
    );
  });
});
