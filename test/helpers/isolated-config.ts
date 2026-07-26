// Point ARGUS_CONFIG_DIR at an empty temp directory *before* any module that captures it at load
// time (e.g. `src/paths.ts`'s `ARGUS_CONFIG_DIR` constant). Import this first in tests that
// otherwise inherit the developer's real `~/.config/argus/argus.json` — e.g. `watch.test.ts`,
// where a local `hub.url`/`hub.key` would make `pushSnapshotForOpts` perform real
// Hub/keychain work during the watch-loop tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ARGUS_CONFIG_DIR) {
  process.env.ARGUS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "argus-test-config-"));
}
