# Capability event model

Capability gap analysis starts with a source-neutral event model. Transcript parsers may
have different record shapes, but aggregation and reporting should not need source-specific
branches to answer whether a skill, tool, or MCP capability was invoked and what is known
about its outcome.

This model is currently CLI-internal. It is part of `ParseResult`, not the pushed dashboard
payload. The shared `@agentdeploymentco/argus-schema` contract should change only when the
longitudinal aggregate shape is defined.

## Event semantics

Each `CapabilityEvent` records:

- source, session, project, and invocation timestamp
- source invocation ID when available
- normalized capability identity
- outcome and failure classification
- whether the assessment is observed, inferred, or not yet assessed
- confidence, duration, retry relationship, and bounded supporting evidence

Capability types are:

- `skill`: an explicit `Skill` or `activate_skill` invocation with a skill name
- `mcp`: an `mcp__<server>__<tool>` invocation, retaining both server and tool identity
- `tool`: every other built-in or custom tool invocation

Outcomes are:

- `success`: evidence supports successful completion
- `failure`: evidence supports failure and includes a failure type
- `partial`: some intended work succeeded, but completion is incomplete or uncertain
- `unknown`: the transcript records an invocation but has not been assessed

`unknown` is not success. Unknown events use `assessmentBasis: "unassessed"` and
`confidence: 0`. Known outcomes must use an `observed` or `inferred` basis with nonzero
confidence. Explicit transcript status and errors are observed; task completion, user
correction, and abandonment may be inferred by later analysis.

The initial failure taxonomy is:

- `authentication`
- `authorization`
- `timeout`
- `not_found`
- `invalid_input`
- `missing_dependency`
- `unsupported_operation`
- `user_correction`
- `abandoned`
- `unknown`

## Source mappings

### Claude Code

Claude `assistant` content blocks with `type: "tool_use"` become capability events.
`tool_use.id` becomes the invocation ID. Streamed content blocks retain their own
invocation timestamp even though token usage is deduplicated at the assistant-message level.
`Skill` calls become skill events and `mcp__...` calls become MCP events.

### Codex

Codex `function_call` records and specialized `*_call` response items become capability
events. `call_id` is retained when present. Calls stay associated with the token-count turn
that currently owns their usage, while their event timestamp comes from the call record.

### Gemini CLI

Gemini `toolCalls` entries become capability events. The call `id` is retained when present.
`activate_skill` becomes a skill event. MCP classification currently follows the same
`mcp__<server>__<tool>` naming convention used elsewhere in Argus.

## Evidence and privacy

Evidence is deliberately smaller than raw transcript content:

- Store short summaries, never raw argument or result objects.
- Collapse evidence to one line and cap it at 280 characters.
- Redact common bearer tokens and secret assignments before storage.
- Mark every evidence item as observed or inferred.
- Keep raw prompt and tool-result content out of capability events.

Redaction is defense in depth, not a substitute for avoiding sensitive input. Parser and
analyzer implementations should construct narrow evidence summaries from known fields
rather than passing arbitrary transcript text to the sanitizer.

## Ownership boundaries

- `parse.ts` owns source mapping, replay/deduplication, invocation IDs, and baseline events.
- `capability-events.ts` owns model invariants, identity normalization, and evidence bounds.
- Follow-on failure and friction analysis enriches events without source-specific report code.
- `aggregate.ts` will own report-ready health and gap metrics after their shape is defined.
- `argus-schema` will own only the approved aggregate fields intended for dashboard storage.
