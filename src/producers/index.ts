// The producer registry. Adding a source = add a file in this directory and one line here.
import type { ImportProducer, NativeProducer } from "../producer.ts";
import { agentsviewProducer } from "./agentsview/index.ts";
import { claudeProducer } from "./claude/index.ts";
import { codexProducer } from "./codex/index.ts";
import { coworkProducer } from "./cowork/index.ts";
import { geminiProducer } from "./gemini/index.ts";

export const NATIVE_PRODUCERS: NativeProducer[] = [claudeProducer, codexProducer, geminiProducer, coworkProducer];
export const IMPORT_PRODUCERS: ImportProducer[] = [agentsviewProducer];
