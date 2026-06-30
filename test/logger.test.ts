import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger.ts";

function memoryStream(): { chunks: string[]; stream: { write(chunk: string): void } } {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  };
}

describe("logger", () => {
  test("prefixes every emitted line with an ISO timestamp and level", () => {
    const { chunks, stream } = memoryStream();
    const log = createLogger({ level: "info", stream });

    log("Reading transcripts...");
    log.warn?.("Missing optional source");

    const lines = chunks.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z INFO\s Reading transcripts\.\.\.$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z WARN\s Missing optional source$/);
  });

  test("filters debug until the level includes it", () => {
    const { chunks, stream } = memoryStream();
    const log = createLogger({ level: "info", stream });

    log.debug?.("hidden");
    expect(chunks).toHaveLength(0);

    log.setLevel?.("debug");
    log.debug?.("visible");
    expect(chunks.join("")).toContain("DEBUG visible");
  });

  test("prefixes each line of a multi-line message", () => {
    const { chunks, stream } = memoryStream();
    const log = createLogger({ level: "info", stream });

    log("one\ntwo");

    const lines = chunks.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ INFO\s one$/);
    expect(lines[1]).toMatch(/ INFO\s two$/);
  });

  test("does not collapse rapid identical lines", () => {
    const { chunks, stream } = memoryStream();
    const log = createLogger({ level: "info", stream });

    for (let i = 0; i < 8; i++) log("[task extraction] prompt line");

    const lines = chunks.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => line.endsWith("INFO  [task extraction] prompt line"))).toBe(true);
    expect(chunks.join("")).not.toContain("repeated");
  });
});
