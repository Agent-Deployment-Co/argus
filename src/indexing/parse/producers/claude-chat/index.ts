import {
  createClaudeChatAuxiliaryParserAdapter,
  createClaudeChatDiscoveryAdapter,
  createClaudeChatTranscriptParserAdapter,
  discoverClaudeChatProjects,
  parseClaudeChatTranscriptPath,
} from "./parser.ts";
import type { NativeProducer, ProducerContext } from "../../../producer.ts";

// claude.ai chat read from the Claude desktop app's local HTTP cache (#94). One conversation = one
// session; the cache holds duplicate snapshots, deduped by uuid via AlternateRepresentation. There is
// no filesystem cwd, so a conversation started in a claude.ai Project is labelled "claude.ai/{Project
// Name}" (resolved via the projects auxiliary, project_uuid → name); conversations outside a project
// fall back to "claude.ai". It does not canonicalize subagents (there are none), dedupe by provider
// message id (the file-level AlternateRepresentation handles duplicates), or observe friction (the
// cache exposes no interrupt/permission/compaction markers).
export const claudeChatProducer: NativeProducer = {
  id: "claude-chat",
  source: "claude-chat",
  capabilities: {
    canonicalizeSubagents: false,
    dedupeByProviderMessageId: false,
    observesFriction: false,
    unknownProjectLabel: () => "claude.ai",
  },
  discoverTranscripts: (ctx: ProducerContext) =>
    createClaudeChatDiscoveryAdapter(ctx.claudeChatCacheDir).discover(),
  transcriptParser: () => createClaudeChatTranscriptParserAdapter(),
  parseTranscriptPath: parseClaudeChatTranscriptPath,
  discoverAuxiliary: (ctx: ProducerContext) => discoverClaudeChatProjects(ctx.claudeChatCacheDir),
  auxiliaryParser: () => createClaudeChatAuxiliaryParserAdapter(),
};
