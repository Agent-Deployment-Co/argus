import { AgentsViewImporter } from "./importer.ts";
import type { ImportProducer, ProducerContext } from "../../producer.ts";
import { defaultUnknownProjectLabel } from "../../reconcile.ts";

// AgentsView is a dependent import producer: it materializes only sessions no native producer owns.
// Imports carry claude relationships + provider ids (so canonicalize + dedupe) but never friction.
export const agentsviewProducer: ImportProducer = {
  id: "agentsview",
  dependsOnNative: true,
  capabilities: {
    canonicalizeSubagents: true,
    dedupeByProviderMessageId: true,
    observesFriction: false,
    unknownProjectLabel: defaultUnknownProjectLabel,
  },
  importer: (ctx: ProducerContext) =>
    ctx.agentsView === "off"
      ? undefined
      : new AgentsViewImporter({ databasePath: ctx.agentsViewDatabasePath }),
};
