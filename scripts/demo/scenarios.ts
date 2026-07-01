// Authored demo corpus: Rachel, a go-to-market knowledge worker at Tyrell Corporation, and the
// agent sessions she runs. This is the reviewable *data* half of the demo generator; `generate.ts`
// expands it deterministically into store records. Everything here is obviously-fake, single-company
// synthetic content (see docs/contributing/voice-and-tone.md): Rachel does sales/marketing/revops/
// AI-ops work, never software of her own, and researches invented companies from the same fictional
// world (Wallace Corp, Rosen Associates, Sebastian Design, Off-World Colonies).
//
// No real paths, names, emails, or transcript text. MCP/product names (hubspot, notion, ...) are
// public and fine to use; the content around them is invented.

import type { AgentSource } from "../../src/types.ts";
import type { TaskFrustration, TaskOutcome } from "../../src/store/store-contract.ts";

/** The demo user and her company. */
export const DEMO_USER = {
  name: "Rachel",
  email: "rachel@tyrell.example",
  company: "Tyrell Corporation",
  home: "/Users/rachel",
} as const;

/** How much friction a session shows. Only Claude Code and Cowork sessions carry friction at all;
 *  the generator ignores these for Codex/Claude Chat. `growth` also drives rapid context growth. */
export type FrictionProfile = "none" | "light" | "heavy" | "growth";

export interface TaskTemplate {
  /** What Rachel was trying to do, in her voice. */
  description: string;
  outcome: TaskOutcome;
  frustration: TaskFrustration;
  /** Short evidence tags for the outcome call. */
  signals?: string[];
  /** One-line rationale for the outcome. */
  outcomeReason: string;
  /** A supporting excerpt (invented). */
  evidence: string;
}

export interface SessionTemplate {
  /** Rachel's opening prompt; becomes the session title. */
  title: string;
  /** Documents the agent read or wrote, under Rachel's home. */
  files?: string[];
  /** Raw tool names used, e.g. "Read", "WebSearch", "mcp__hubspot__search_contacts". */
  tools?: string[];
  /** Skills invoked (plugin:skill or a bare skill), e.g. "gtm-research:account-brief". */
  skills?: string[];
  /** Roughly how many model responses the session took. The generator varies this a little. */
  turns?: number;
  friction?: FrictionProfile;
  /** One to three tasks the agent worked through. */
  tasks: TaskTemplate[];
  /** Instantiate this template more than once (across different dates) for volume. Default 1. */
  instances?: number;
}

export interface ProjectScenario {
  /** Project slug, i.e. the folder the agent worked in. */
  project: string;
  source: AgentSource;
  /** Primary model for the project. */
  model: string;
  /** Some sessions mix in this model too, so cost is re-walked per message. */
  secondaryModel?: string;
  /** Flavor only, for readability. */
  persona: "sales" | "marketing" | "revops" | "ai-ops";
  sessions: SessionTemplate[];
}

const doc = (p: string) => `${DEMO_USER.home}/${p}`;

// GTM MCP servers Rachel's agents lean on. Public product names; invented usage.
const HUBSPOT = "mcp__hubspot__search_contacts";
const HUBSPOT_DEALS = "mcp__hubspot__list_deals";
const SALESFORCE = "mcp__salesforce__soql_query";
const GONG = "mcp__gong__list_calls";
const NOTION = "mcp__notion__search";
const GDRIVE = "mcp__gdrive__read_document";
const SLACK = "mcp__slack__post_message";
const GMAIL = "mcp__gmail__create_draft";

export const PROJECTS: ProjectScenario[] = [
  // ---- Sales (Claude Cowork) --------------------------------------------------------------------
  {
    project: "wallace-corp-expansion",
    source: "cowork",
    model: "claude-sonnet-4-6",
    persona: "sales",
    sessions: [
      {
        title: "Draft the Wallace Corp expansion account brief",
        files: [doc("gtm/wallace-corp/account-brief.md"), doc("gtm/wallace-corp/org-chart.md")],
        tools: ["Read", "Write", HUBSPOT, GONG, "WebSearch"],
        skills: ["gtm-research:account-brief"],
        turns: 9,
        friction: "light",
        instances: 4,
        tasks: [
          {
            description: "Pull Wallace Corp's org chart and recent activity into a one-page brief",
            outcome: "success",
            frustration: "none",
            signals: ["clear ask", "confirmed complete"],
            outcomeReason: "Brief was written and Rachel moved on to the next account.",
            evidence: "Wrote account-brief.md covering stakeholders, spend, and last three calls.",
          },
          {
            description: "Summarize the last three Gong calls with Wallace Corp",
            outcome: "success",
            frustration: "low",
            signals: ["one re-ask for a shorter version"],
            outcomeReason: "Delivered after a follow-up asking to trim it to five bullets.",
            evidence: "Condensed three call transcripts into a five-bullet recap.",
          },
          {
            description: "Draft a mutual action plan for the expansion",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel exported the plan to share with the champion.",
            evidence: "Outlined a mutual action plan with owners and target dates.",
          },
        ],
      },
      {
        title: "Build the outreach sequence for the Wallace Corp expansion",
        files: [doc("gtm/wallace-corp/outreach-sequence.md")],
        tools: ["Read", "Write", GMAIL, HUBSPOT],
        skills: ["gtm-research:account-brief"],
        turns: 7,
        friction: "none",
        tasks: [
          {
            description: "Write a four-touch email sequence tailored to the CFO",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Sequence drafted and saved as Gmail drafts for review.",
            evidence: "Created four Gmail drafts and saved copy to outreach-sequence.md.",
          },
          {
            description: "Adapt the sequence for the VP of Operations persona",
            outcome: "success",
            frustration: "low",
            signals: ["one re-ask to shorten it"],
            outcomeReason: "Second variant matched the shorter format Rachel wanted.",
            evidence: "Produced a VP-of-Ops variant of the four-touch sequence.",
          },
        ],
      },
      {
        title: "Prep me for the Wallace Corp renewal call",
        files: [doc("gtm/wallace-corp/call-prep.md")],
        tools: ["Read", GONG, SALESFORCE, "WebFetch"],
        turns: 6,
        friction: "heavy",
        tasks: [
          {
            description: "Pull the open support tickets that could threaten the renewal",
            outcome: "success",
            frustration: "low",
            signals: ["declined a Salesforce write"],
            outcomeReason: "Got the ticket list after declining an auto-update to the record.",
            evidence: "Listed four open support tickets tied to the account.",
          },
          {
            description: "Assemble talking points and open risks ahead of the renewal call",
            outcome: "unclear",
            frustration: "high",
            signals: ["repeated re-asks", "interrupted twice", "declined a Salesforce write"],
            outcomeReason: "Rachel kept redirecting and stopped before a final version was agreed.",
            evidence: "Several drafts of talking points; last turn was interrupted mid-answer.",
          },
        ],
      },
    ],
  },
  {
    project: "enterprise-deal-desk",
    source: "claude-chat",
    model: "claude-sonnet-4-6",
    persona: "sales",
    sessions: [
      {
        title: "What discount can I offer Rosen Associates at 200 seats?",
        turns: 4,
        tasks: [
          {
            description: "Work out the approved discount for a 200-seat Rosen Associates deal",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel got the tier and threshold she needed to quote.",
            evidence: "Explained the 200-seat volume tier and the sign-off needed above it.",
          },
        ],
      },
      {
        title: "Rewrite this proposal intro to sound less templated",
        turns: 3,
        instances: 4,
        tasks: [
          {
            description: "Make the proposal opening feel written for Rosen Associates specifically",
            outcome: "success",
            frustration: "low",
            signals: ["one re-ask for a warmer tone"],
            outcomeReason: "Second pass landed the tone Rachel wanted.",
            evidence: "Reworked the intro twice; kept the version naming their expansion goal.",
          },
        ],
      },
    ],
  },

  // ---- Marketing (Claude Cowork) ----------------------------------------------------------------
  {
    project: "q3-launch-campaign",
    source: "cowork",
    model: "claude-opus-4-1",
    secondaryModel: "claude-haiku-4-5-20251001",
    persona: "marketing",
    sessions: [
      {
        title: "Draft the Q3 launch campaign brief",
        files: [doc("marketing/q3-launch/campaign-brief.md"), doc("marketing/q3-launch/messaging.md")],
        tools: ["Read", "Write", NOTION, "WebSearch", GDRIVE],
        skills: ["content-studio:blog-draft"],
        turns: 11,
        friction: "growth",
        tasks: [
          {
            description: "Turn the positioning doc into a full campaign brief",
            outcome: "success",
            frustration: "low",
            signals: ["long session", "context compacted once"],
            outcomeReason: "Brief finished, though the session grew large before wrapping.",
            evidence: "Expanded messaging.md into a brief with audience, channels, and timeline.",
          },
          {
            description: "Draft three headline options for the launch",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel picked one of the three headlines.",
            evidence: "Proposed three headlines; the second was marked as the pick.",
          },
          {
            description: "Map the campaign messaging to the three target segments",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Segment map approved and folded into the brief.",
            evidence: "Added a segment-to-message map to the brief.",
          },
        ],
      },
      {
        title: "Write the launch blog post from the campaign brief",
        files: [doc("marketing/q3-launch/blog-post.md")],
        tools: ["Read", "Write", GDRIVE, "WebFetch"],
        skills: ["content-studio:blog-draft"],
        turns: 8,
        friction: "light",
        instances: 4,
        tasks: [
          {
            description: "Draft a 900-word launch blog post in Tyrell's voice",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Draft delivered at length and saved to the docs folder.",
            evidence: "Wrote blog-post.md at ~900 words following the brief's outline.",
          },
          {
            description: "Write the meta description and title tag for the post",
            outcome: "success",
            frustration: "none",
            outcomeReason: "SEO fields drafted and saved with the post.",
            evidence: "Produced a 155-character meta description and a title tag.",
          },
        ],
      },
      {
        title: "Turn the blog post into a week of social copy",
        files: [doc("marketing/q3-launch/social-calendar.md")],
        tools: ["Read", "Write", SLACK],
        skills: ["content-studio:social-copy"],
        turns: 6,
        friction: "none",
        tasks: [
          {
            description: "Produce five social posts and a posting schedule",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Calendar and posts were saved and shared to the channel.",
            evidence: "Created five posts and a schedule; posted the plan to Slack.",
          },
          {
            description: "Draft two LinkedIn thought-leadership variants",
            outcome: "success",
            frustration: "low",
            signals: ["one re-ask for a less salesy tone"],
            outcomeReason: "Second pass toned down the pitch.",
            evidence: "Wrote two LinkedIn variants; kept the softer one.",
          },
        ],
      },
    ],
  },
  {
    project: "competitive-research",
    source: "claude-chat",
    model: "claude-sonnet-4-6",
    persona: "marketing",
    sessions: [
      {
        title: "How does Off-World Colonies position against us?",
        turns: 5,
        instances: 5,
        tasks: [
          {
            description: "Compare Off-World Colonies' positioning and pricing to Tyrell's",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel got a clear side-by-side she could paste into a doc.",
            evidence: "Laid out positioning, pricing tiers, and two gaps to exploit.",
          },
        ],
      },
      {
        title: "Give me talking points against Sebastian Design's new feature",
        turns: 4,
        tasks: [
          {
            description: "Draft objection-handling points for Sebastian Design's launch",
            outcome: "unclear",
            frustration: "low",
            signals: ["needed a source it couldn't verify"],
            outcomeReason: "Useful points, but Rachel wasn't sure the feature claim was current.",
            evidence: "Offered three talking points and flagged one unverified claim.",
          },
        ],
      },
    ],
  },
  {
    project: "exec-briefings",
    source: "cowork",
    model: "claude-opus-4-1",
    persona: "marketing",
    sessions: [
      {
        title: "Draft the narrative for this quarter's board deck",
        files: [doc("exec/board-deck/narrative.md"), doc("exec/board-deck/metrics.csv")],
        tools: ["Read", "Write", GDRIVE, NOTION],
        skills: ["deep-research"],
        turns: 10,
        friction: "heavy",
        tasks: [
          {
            description: "Pull the three headline metrics and check them against the source",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Numbers reconciled with the metrics sheet.",
            evidence: "Verified ARR, win rate, and pipeline coverage against metrics.csv.",
          },
          {
            description: "Write the story arc connecting this quarter's GTM metrics",
            outcome: "success",
            frustration: "low",
            signals: ["one interruption to reorder sections"],
            outcomeReason: "Narrative approved after a reorder of the middle sections.",
            evidence: "Drafted a three-act narrative tied to the metrics.csv figures.",
          },
          {
            description: "Draft speaker notes for the GTM section",
            outcome: "unclear",
            frustration: "high",
            signals: ["repeated re-asks", "interrupted"],
            outcomeReason: "Notes weren't finalized before Rachel stopped for the day.",
            evidence: "Several drafts of speaker notes; the last was interrupted.",
          },
        ],
      },
      {
        title: "Write this week's GTM update for the leadership channel",
        files: [doc("exec/weekly-update.md")],
        tools: ["Read", "Write", SLACK, HUBSPOT_DEALS],
        skills: ["weekly-update"],
        turns: 5,
        friction: "light",
        instances: 8,
        tasks: [
          {
            description: "Summarize the week's pipeline movement into a short update",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Update posted to the leadership channel.",
            evidence: "Pulled deal changes and wrote a six-line update, posted to Slack.",
          },
        ],
      },
    ],
  },

  // ---- RevOps ----------------------------------------------------------------------------------
  {
    project: "pipeline-hygiene",
    source: "cowork",
    model: "claude-haiku-4-5-20251001",
    persona: "revops",
    sessions: [
      {
        title: "Find and merge duplicate accounts in the pipeline",
        files: [doc("revops/pipeline/duplicate-accounts.csv")],
        tools: ["Read", "Write", SALESFORCE, HUBSPOT],
        skills: ["revops-toolkit:pipeline-audit"],
        turns: 7,
        friction: "heavy",
        instances: 4,
        tasks: [
          {
            description: "Identify duplicate accounts and propose merges",
            outcome: "success",
            frustration: "low",
            signals: ["declined two auto-merges to review them first"],
            outcomeReason: "Rachel accepted the merge list after reviewing the risky ones by hand.",
            evidence: "Flagged 14 duplicates; Rachel declined two auto-merges for manual review.",
          },
          {
            description: "Draft the merge plan and flag the risky pairs for review",
            outcome: "success",
            frustration: "low",
            signals: ["interrupted once"],
            outcomeReason: "Plan produced; Rachel paused on the risky merges.",
            evidence: "Wrote a merge plan marking five high-risk pairs.",
          },
        ],
      },
      {
        title: "Audit which deals are missing a close date",
        files: [doc("revops/pipeline/stage-audit.csv")],
        tools: ["Read", SALESFORCE, HUBSPOT_DEALS],
        skills: ["revops-toolkit:pipeline-audit"],
        turns: 5,
        friction: "light",
        tasks: [
          {
            description: "List open deals missing a close date or next step",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel got the cleanup list she asked for.",
            evidence: "Produced a 22-row list of deals missing required fields.",
          },
        ],
      },
    ],
  },
  {
    project: "quarterly-forecast",
    source: "codex",
    model: "gpt-5.4",
    secondaryModel: "gpt-5",
    persona: "revops",
    sessions: [
      {
        title: "Build the Q3 forecast model from the pipeline export",
        files: [doc("revops/forecast/q3-forecast.csv"), doc("revops/forecast/assumptions.md")],
        tools: ["read_file", "write_file", "run_shell_command"],
        skills: ["revops-toolkit:forecast"],
        turns: 9,
        instances: 3,
        tasks: [
          {
            description: "Reconcile the pipeline export against the CRM totals",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Totals matched after fixing a currency column.",
            evidence: "Aligned the export sums with the CRM within rounding.",
          },
          {
            description: "Turn the pipeline export into a weighted Q3 forecast",
            outcome: "success",
            frustration: "low",
            signals: ["one re-run after fixing a stage weight"],
            outcomeReason: "Forecast produced after correcting a stage-probability weight.",
            evidence: "Computed a weighted forecast and wrote assumptions.md alongside it.",
          },
          {
            description: "Document the forecast assumptions for the readout",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Assumptions written alongside the model.",
            evidence: "Wrote assumptions.md covering weights and cutoffs.",
          },
        ],
      },
      {
        title: "Rebalance territories so reps are within 15% of quota",
        files: [doc("revops/forecast/territory-plan.csv")],
        tools: ["read_file", "write_file"],
        turns: 7,
        tasks: [
          {
            description: "Summarize the current quota load per rep",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Rachel got the current per-rep load table.",
            evidence: "Produced a per-rep quota-load summary.",
          },
          {
            description: "Propose a territory split that evens out quota load",
            outcome: "failure",
            frustration: "high",
            signals: ["repeated re-asks", "constraints conflicted"],
            outcomeReason: "No split satisfied both the geography and quota constraints Rachel set.",
            evidence: "Several attempts; each left at least one rep >15% off quota.",
          },
        ],
      },
    ],
  },
  {
    project: "rev-reporting",
    source: "codex",
    model: "gpt-5.5",
    persona: "revops",
    sessions: [
      {
        title: "Generate the weekly revenue dashboard export",
        files: [doc("revops/reporting/weekly-dashboard.csv")],
        tools: ["read_file", "write_file", "run_shell_command"],
        turns: 5,
        instances: 8,
        tasks: [
          {
            description: "Produce the weekly revenue and pipeline dashboard CSV",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Export generated and matched last week's format.",
            evidence: "Wrote weekly-dashboard.csv with the standard columns.",
          },
        ],
      },
    ],
  },

  // ---- AI-ops (Rachel builds and tunes her own GTM agents) --------------------------------------
  {
    project: "sales-agent-ops",
    source: "claude",
    model: "claude-sonnet-4-6",
    persona: "ai-ops",
    sessions: [
      {
        title: "Set up the HubSpot MCP server for the outreach agent",
        files: [doc("agent-ops/outreach-agent/config.md"), doc("agent-ops/outreach-agent/prompt.md")],
        tools: ["Read", "Write", "Edit", "Bash", HUBSPOT, "WebFetch"],
        turns: 8,
        friction: "heavy",
        tasks: [
          {
            description: "Connect the outreach agent to HubSpot and confirm it can read contacts",
            outcome: "success",
            frustration: "low",
            signals: ["one permission declined", "one interruption"],
            outcomeReason: "Connection worked after Rachel approved the contact-read scope.",
            evidence: "Configured the server; a test contact lookup returned results.",
          },
          {
            description: "Write setup notes so a teammate can reproduce the config",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Notes saved to config.md.",
            evidence: "Documented the MCP setup steps in config.md.",
          },
        ],
      },
      {
        title: "Tune the outreach agent's tone so it stops sounding pushy",
        files: [doc("agent-ops/outreach-agent/prompt.md")],
        tools: ["Read", "Edit", "Bash"],
        turns: 10,
        friction: "growth",
        instances: 3,
        tasks: [
          {
            description: "Add a worked example of a good outreach reply to the prompt",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Example added to the prompt.",
            evidence: "Inserted a worked example into prompt.md.",
          },
          {
            description: "Compare the before and after tone on five sample leads",
            outcome: "unclear",
            frustration: "low",
            signals: ["hard to judge the improvement"],
            outcomeReason: "The change looked real but was hard to quantify.",
            evidence: "Ran five before/after comparisons; results were mixed.",
          },
          {
            description: "Revise the system prompt to soften the outreach tone",
            outcome: "unclear",
            frustration: "high",
            signals: ["long session", "compacted twice", "repeated re-asks"],
            outcomeReason: "Tone improved but Rachel wasn't ready to call it final.",
            evidence: "Iterated on the prompt many times; results were closer but not signed off.",
          },
        ],
      },
    ],
  },
  {
    project: "agent-eval-harness",
    source: "claude",
    model: "claude-sonnet-4-6",
    secondaryModel: "claude-haiku-4-5-20251001",
    persona: "ai-ops",
    sessions: [
      {
        title: "Run the outreach agent against the eval set and score it",
        files: [doc("agent-ops/evals/eval-set.md"), doc("agent-ops/evals/results.csv")],
        tools: ["Read", "Write", "Bash"],
        skills: ["deep-research"],
        turns: 7,
        friction: "light",
        instances: 4,
        tasks: [
          {
            description: "Score the outreach agent's replies against the eval rubric",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Scores written to results.csv for review.",
            evidence: "Ran the eval set and recorded per-case scores.",
          },
          {
            description: "Flag the eval cases the agent failed",
            outcome: "success",
            frustration: "none",
            outcomeReason: "Failing cases listed for follow-up.",
            evidence: "Marked six failing cases in results.csv.",
          },
        ],
      },
    ],
  },
];

/** The marketplace Rachel's plugins come from (invented). */
export const PLUGIN_MARKETPLACE = "tyrell-hub";

export interface PluginCatalogEntry {
  /** Plugin name; the part before ":" in a `plugin:skill` id. */
  name: string;
  enabled: boolean;
  version: string;
  /** How long ago it was installed, relative to the demo anchor date. */
  installedDaysAgo: number;
}

/** Rachel's installed plugins. The first three own skills her agents actually use; `meeting-notes`
 *  and `seo-optimizer` are enabled but never used (drives the "enabled but unused" recommendation);
 *  `legacy-crm` is installed but disabled. */
export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  { name: "gtm-research", enabled: true, version: "2.4.0", installedDaysAgo: 120 },
  { name: "content-studio", enabled: true, version: "1.9.2", installedDaysAgo: 90 },
  { name: "revops-toolkit", enabled: true, version: "3.1.0", installedDaysAgo: 60 },
  { name: "meeting-notes", enabled: true, version: "1.2.0", installedDaysAgo: 150 },
  { name: "seo-optimizer", enabled: true, version: "0.8.1", installedDaysAgo: 45 },
  { name: "legacy-crm", enabled: false, version: "1.0.0", installedDaysAgo: 300 },
];
