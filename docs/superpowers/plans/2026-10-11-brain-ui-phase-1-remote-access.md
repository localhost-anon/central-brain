# Brain UI Phase 1 — Remote Access Implementation Plan

> Executed natively in one session (Brain decision: user granted full autonomy for phase 1), followed by one fresh whole-branch review.

**Goal:** GOAL-2026-0069 — phone reaches `http://192.168.70.50:4410` over Tailscale; only allowlisted source IPs connect; Mac keeps `brain ui` running; web-ui merged to `main`.

**Spec:** `docs/superpowers/specs/2026-10-11-brain-ui-phase-1-remote-access-design.md`

**Tech stack:** TypeScript strict ESM, `node:http`, commander, vitest, launchd.

## Global constraints
- The server never listens on `0.0.0.0` / `::`. It listens on `127.0.0.1` always, and on the LAN IP only when that IP exists locally.
- The default allowlist is `127.0.0.1`, `192.168.70.50` and `192.168.70.122`. `--allow-ip` replaces it, and `127.0.0.1` is always kept.
- No login. The Host check and the Origin (non-GET) check stay.
- No sudo. The live `brain.db` is never written by tests.
- Each commit ends with `Goal: GOAL-2026-0069` and the Co-Authored-By trailer.

## Tasks

1. **Config + guards** (`src/web/config.ts`, `src/web/server.ts`, `tests/web-remote.test.ts`)
   - Add `UI_DEFAULTS` and `resolveUiConfig(flags, env)`.
   - Add `normaliseIp`.
   - Implement the guard order: source IP, then Host, then Origin.
   - Add the injectable `remoteAddressOf` option.
   - Rate-limit the refusal log.
   - Tests:
     - an allowed IP gets 200 and a refused IP gets 403;
     - `::ffff:` addresses are normalised;
     - a LAN Host is allowed;
     - a foreign Host gets 403.
2. **LAN listener lifecycle** (`src/web/server.ts`)
   - Run one shared handler on two servers.
   - Add the injectable `interfaces()` and `recheckMs` options.
   - Start the LAN listener when the address appears, stop it when the address goes away, and log each state change once.
   - Return `lanUrl`.
   - Tests:
     - an absent address gives localhost only, a log line, and a working API;
     - an address that appears later (via `::1`) brings up the LAN listener.
3. **Migration skip edge** (`src/db/connection.ts`, `tests/partial-schema.test.ts`)
   - After drizzle's `migrate`, apply any journal entries whose hash is still missing, in one transaction, and record their rows.
   - Test: a DB with 0000–0005 applied gets 0006, and a rerun is a no-op.
4. **CLI** (`src/cli/index.ts`)
   - `brain ui` gains `--host` / `--allow-ip` and prints `lanUrl`.
   - Add `ui install-agent [--dry-run]`, `ui uninstall-agent` and `ui agent-status`.
   - The plist runs `caffeinate -s` with absolute paths, `KeepAlive` and `RunAtLoad`, logs to `~/.central-brain/logs/ui.log`, and carries the installing shell's `PATH`.
   - Test: `install-agent --dry-run` output.
5. **Script + docs**
   - Fix `check-migration-on-copy.ts` to compare statuses and versions before vs after.
   - README: add the "Phone access" section.
   - Web-UI spec §7: add a pointer to the phase-1 spec.
6. **Ship**
   - Run the full suite, tsc and build.
   - Run one fresh whole-branch review and fix what it finds.
   - Open the PR and merge it with the admin bypass (user-authorised).
   - Install the agent and run the real-world checks.
   - Close GOAL-2026-0010.
   - Record verifications.
