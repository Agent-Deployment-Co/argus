// The producer registry. Adding a source = add a file in this directory and one line here.
import type { ImportProducer, NativeProducer } from "../producer.ts";
import { agentsviewProducer } from "./agentsview.ts";
import { claudeProducer } from "./claude.ts";
import { codexProducer } from "./codex.ts";
import { geminiProducer } from "./gemini.ts";

export const NATIVE_PRODUCERS: NativeProducer[] = [claudeProducer, codexProducer, geminiProducer];
export const IMPORT_PRODUCERS: ImportProducer[] = [agentsviewProducer];
