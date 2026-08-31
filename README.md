# Central Brain

Persistent goal-oriented memory for Claude Code. See ARCHITECTURE.md.

- DB: `~/.central-brain/brain.db` (override with `BRAIN_DB`)
- CLI: `brain --help` (build: `npm run build`; dev: `npm run brain --`)
- MCP: registered as `central-brain` (tools `brain_*`)
- Hook: `hooks/session-start.sh` injects `brain context get` into every session
- Backup: `brain backup` → `~/.central-brain/backups/`
- Tests: `npm test`
