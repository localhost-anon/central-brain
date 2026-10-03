# Central Brain

Persistent goal-oriented memory for Claude Code. See ARCHITECTURE.md.

- DB: `~/.central-brain/brain.db` (override with `BRAIN_DB`)
- CLI: `brain --help` (build: `npm run build`; dev: `npm run brain --`)
- MCP: registered as `central-brain` (tools `brain_*`)
- Hook: `hooks/session-start.sh` injects `brain context get` into every session
- Backup: `brain backup` → `~/.central-brain/backups/`
- Tests: `npm test`
- Scan: `brain project scan ~/Projects` (re-run anytime; idempotent)
- Failures: `brain failure add|search|show|resolve|solution` (the §66 reuse loop)
- Verification: `brain verify add [--verdict verified|partial|failed]|goal` (verdicts drive requirement status; `--passed/--failed` still work)
- Converge: `brain goal converge GOAL-…` (typed findings that gate `goal complete`; v1 goals refuse on CRITICAL/HIGH, `--force --reason` marks completion forced); `brain goal cancel GOAL-… <reason>`; `brain goal link-project GOAL-… <project>`; `brain principle ack GOAL-… <knowledgeId> honoured|exception <note>`
- Question answers: `brain goal question answer <id> <answer> --as success_criterion [--verify <method>] [--coverage <category>]`
- Migration check: `npx tsx scripts/check-migration-on-copy.ts` (migrates a copy, never the live DB). MCP adds `brain_goal_converge`, `brain_goal_cancel`, `brain_goal_link_project`, `brain_principle_ack`
- Resume: `brain goal resume GOAL-…` (contract, work state, next action)
- Semantic: `brain embed reindex` (local ONNX, model cached in ~/.central-brain/models); all `search` commands are hybrid FTS+vector
- Import: `brain import claude-mem` (idempotent; observations carry `claude-mem:<id>` refs)
- Intake: `brain goal intake GOAL-…` (context, §9 gaps → questions, a standing `review:behaviour` question for user-visible choices, review items, duplicates); `brain goal question add|answer [--as type]|dismiss|list`; `brain goal set --risk`; `brain goal lock` refuses incomplete contracts (`--force --reason` records a decision)
- Schema: sessions never auto-migrate the live DB; run `brain migrate` after pulling schema changes
