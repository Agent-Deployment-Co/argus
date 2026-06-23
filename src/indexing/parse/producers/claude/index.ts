import {
  createClaudeHistoryParserAdapter,
  createClaudeTranscriptDiscoveryAdapter,
  createClaudeTranscriptParserAdapter,
  discoverClaudeHistory,
  discoverClaudeSessionTranscripts,
  parseClaudeTranscriptPath,
  reconstructClaudeDialogue,
} from "./parser.ts";
import type { NativeProducer, ProducerContext } from "../../../producer.ts";

// Claude observes everything: subagent canonicalization, provider-id dedup, and friction.
export const claudeProducer: NativeProducer = {
  id: "claude",
  source: "claude",
  capabilities: {
    canonicalizeSubagents: true,
    dedupeByProviderMessageId: true,
    observesFriction: true,
  },
  discoverTranscripts: (ctx: ProducerContext) =>
    createClaudeTranscriptDiscoveryAdapter(ctx.projectsDir).discover(),
  transcriptParser: () => createClaudeTranscriptParserAdapter(),
  parseTranscriptPath: parseClaudeTranscriptPath,
  discoverSessionTranscripts: discoverClaudeSessionTranscripts,
  reconstructDialogue: reconstructClaudeDialogue,
  discoverAuxiliary: (ctx: ProducerContext) => discoverClaudeHistory(ctx.historyFile),
  auxiliaryParser: () => createClaudeHistoryParserAdapter(),
};
