import {
  createCodexTranscriptDiscoveryAdapter,
  createCodexTranscriptParserAdapter,
  parseCodexTranscriptPath,
} from "./parser.ts";
import type { NativeProducer, ProducerContext } from "../../producer.ts";

// Codex emits no relationships, provider ids, or friction events.
export const codexProducer: NativeProducer = {
  id: "codex",
  source: "codex",
  capabilities: {
    canonicalizeSubagents: false,
    dedupeByProviderMessageId: false,
    observesFriction: false,
  },
  discoverTranscripts: (ctx: ProducerContext) =>
    createCodexTranscriptDiscoveryAdapter(ctx.codexSessionsDir).discover(),
  transcriptParser: () => createCodexTranscriptParserAdapter(),
  parseTranscriptPath: parseCodexTranscriptPath,
};
