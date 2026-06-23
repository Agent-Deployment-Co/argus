import {
  createCoworkTranscriptDiscoveryAdapter,
  createCoworkTranscriptParserAdapter,
  discoverCoworkTranscripts,
  parseCoworkTranscriptPath,
  reconstructCoworkDialogue,
} from "./parser.ts";
import type { NativeProducer, ProducerContext } from "../../../producer.ts";

export const coworkProducer: NativeProducer = {
  id: "cowork",
  source: "cowork",
  capabilities: {
    canonicalizeSubagents: false,
    dedupeByProviderMessageId: true,
    observesFriction: true,
    unknownProjectLabel: (session) => {
      // rawProjectId carries title/processName from local_<id>.json for sandboxed sessions
      if (session.rawProjectId) return session.rawProjectId;
      // Fall back to team-session-id prefix from the transcript path hierarchy
      const parts = session.transcriptPath.split(/[/\\]/);
      const localIdx = parts.findIndex((p) => p.startsWith("local_"));
      const teamId = (localIdx > 0 ? parts[localIdx - 1] : undefined) ?? "unknown";
      return `cowork/${teamId.slice(0, 8)}`;
    },
  },
  discoverTranscripts: (ctx: ProducerContext) =>
    discoverCoworkTranscripts(ctx.coworkSessionsDir),
  transcriptParser: () => createCoworkTranscriptParserAdapter(),
  parseTranscriptPath: parseCoworkTranscriptPath,
  reconstructDialogue: reconstructCoworkDialogue,
};
