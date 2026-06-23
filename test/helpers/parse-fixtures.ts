// Test helper: produce a ParseResult from fixtures by running the real indexing pipeline against a
// throwaway temp store, then discarding it. Replaces the removed monolithic oracle (parseAll) in
// tests that just need a ParseResult to feed aggregate/contract/serve assertions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAllIncremental,
  type IncrementalParseOptions,
} from "../../src/indexing/pipeline.ts";
import type { ParseResult } from "../../src/types.ts";

export async function parseFixtures(opts: IncrementalParseOptions = {}): Promise<ParseResult> {
  const dir = mkdtempSync(join(tmpdir(), "argus-fix-"));
  try {
    return await parseAllIncremental({ ...opts, storePath: join(dir, "argus.db") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
