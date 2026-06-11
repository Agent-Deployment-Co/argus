# AgentsView import compatibility

Issue #22 adds a read-only importer for AgentsView's SQLite database. It targets the schema
present in `kenn-io/agentsview` at revision `918ad58433625128b46f177053e8a2f6c8918dab`.

Argus opens the database read-only, reads inside a single transaction, and compares the file
fingerprint before probing, before import, and after import. A changed fingerprint or schema
hash rejects the import so a later merge step can use native transcript parsing instead.

Imported data is source-scoped normalized facts:

- `sessions` supply session metadata, source IDs, parent links, file identity, and coverage.
- `messages.token_usage` supplies assistant usage-bearing facts.
- `usage_events` supplies usage-bearing facts for schemas that store accounting outside a
  message row. Reasoning tokens are counted as output tokens.
- `tool_calls` supplies invocation IDs, bounded arguments, explicit skills, MCP names, file
  paths, and stored result lengths.

Known fidelity constraints remain explicit in provenance:

- Claude `attributionSkill` is not stored by AgentsView.
- Claude subagent folding is only partial because AgentsView's session relationships do not
  exactly match Argus's transcript-derived model.
- Codex accounting is marked partial because AgentsView rows do not preserve Argus's exact
  `token_count` replay boundaries.
- Gemini nested discovery is partial because AgentsView may not contain every nested transcript
  representation Argus discovers natively.
- `tool_result_events` are detected but not treated as complete parity; #23 owns native
  enrichment and merge precedence.
