import {
  createGeminiAuxiliaryParserAdapter,
  createGeminiTranscriptDiscoveryAdapter,
  createGeminiTranscriptParserAdapter,
  discoverGeminiAuxiliaryFiles,
  parseGeminiTranscriptPath,
  reconstructGeminiDialogue,
} from "./parser.ts";
import type { NativeProducer, ProducerContext } from "../../../producer.ts";
import { defaultUnknownProjectLabel } from "../../../reconcile.ts";

// Gemini resolves cwd from auxiliary project roots and labels cwd-less sessions by transcript file.
// It does not (today) canonicalize subagents or dedupe by provider id.
export const geminiProducer: NativeProducer = {
  id: "gemini",
  source: "gemini",
  capabilities: {
    canonicalizeSubagents: false,
    dedupeByProviderMessageId: false,
    observesFriction: false,
    unknownProjectLabel: defaultUnknownProjectLabel,
  },
  discoverTranscripts: (ctx: ProducerContext) =>
    createGeminiTranscriptDiscoveryAdapter(ctx.geminiDir).discover(),
  transcriptParser: () => createGeminiTranscriptParserAdapter(),
  parseTranscriptPath: parseGeminiTranscriptPath,
  reconstructDialogue: reconstructGeminiDialogue,
  discoverAuxiliary: (ctx: ProducerContext) => discoverGeminiAuxiliaryFiles(ctx.geminiDir),
  auxiliaryParser: () => createGeminiAuxiliaryParserAdapter(),
};
