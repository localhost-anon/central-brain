# Brain UI Phase 1 — Reach It from the Phone (Design)

**Goal:** GOAL-2026-0069 · **Date:** 2026-10-11 · **Roadmap:** Brain decision 39 (full remote dev in four phases) · **Builds on:** `2026-09-28-central-brain-web-ui-design.md`

## 1. Outcome

From the phone, with Tailscale on, `http://192.168.70.50:4410` opens the Brain web UI. The UI is served by the Mac, which stays awake on power. Only localhost, the Mac itself and the TrueNAS subnet router can connect. The `worktree-web-ui` branch is merged to `main` through a PR.

## 2. Decisions (user, 2026-10-11)

| Decision | Choice | Brain ref |
|---|---|---|
| Network path | Phone → Tailscale → `truenas-scale` subnet route (`192.168.70.0/24`) → Mac LAN IP | decision 37 |
| Mac address | Fixed `192.168.70.50` (DHCP reservation, user-managed) | decision 39 |
| Host | Mac stays the host and stays awake; no move to TrueNAS | decision 37 |
| Login | None for now; plain HTTP | decision 38 |
| Safeguard | Source-IP allowlist ON | decision 39 |
| End goal | Full remote dev; this spec is phase 1 of 4 | decision 39 |

**Accepted risk (decision 38).** There is no login. The source-IP allowlist is the only gate against other LAN devices. Any device that can make TCP connections from an allowlisted IP can launch auto-mode Claude workers on the Mac. Two examples: TrueNAS itself, and any tailnet device allowed to use the subnet route.

## 3. Design

### 3.1 Listen addresses — `src/web/server.ts`

- The server always listens on `127.0.0.1:<port>`.
- When `--host <ip>` is given (the default comes from config, §3.4), the server also listens on `<ip>:<port>`. It does this only if `<ip>` is an address of a local interface (`os.networkInterfaces()`).
- If the address is missing (the Mac is on another network), the server:
  - logs `LAN address <ip> not present; serving localhost only`;
  - checks again every 30 s;
  - starts the LAN listener when the address appears;
  - closes it if the address goes away.
- The server never listens on `0.0.0.0` or `::`.
- `startUiServer` returns `{ url, lanUrl | null, … }`. `brain ui` prints both.

### 3.2 Request guards — evaluated in this order, before routing

1. **Source IP.** The server reads `req.socket.remoteAddress` and normalises IPv4-mapped IPv6 (`::ffff:a.b.c.d` → `a.b.c.d`). If the address is not in the allowlist, the server responds `403 Forbidden source`. It logs `refused <ip> <method> <path>`, rate-limited to one line per IP per minute.
2. **Host.** The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `<lan-ip>:<port>`. Otherwise the response is `403 Forbidden host`. This is the DNS-rebinding guard.
3. **Origin (non-GET).** For non-GET requests, `Origin` must be `http://` plus one of the allowed hosts. Otherwise the response is `403`. This is the cross-site request guard.

The default allowlist is `127.0.0.1`, `192.168.70.50` and `192.168.70.122`. The `--allow-ip <ip>` option can be repeated, and it **replaces** the default list when given. The server always adds `127.0.0.1`.

### 3.3 Always on — launchd agent

`brain ui install-agent [--host --port --allow-ip…]` writes `~/Library/LaunchAgents/dev.central-brain.ui.plist` and loads it with `launchctl bootstrap gui/<uid>`. The plist sets:

- `ProgramArguments`: `/usr/bin/caffeinate -s <node> <repo>/dist/cli/index.js ui --no-open --host … --port … --allow-ip …`. Absolute paths are resolved at install time.
- `RunAtLoad true` and `KeepAlive true`.
- `StandardOutPath` / `StandardErrorPath` → `~/.central-brain/logs/ui.log`. The directory is created.
- `EnvironmentVariables.PATH`: the installing shell's `PATH`, so that the worker can find `claude`.

`brain ui uninstall-agent` boots the agent out and removes the plist. `brain ui agent-status` prints `launchctl print` state (running / pid / last exit).

`caffeinate -s` prevents system sleep **only while on AC power**. Closing the lid still sleeps a MacBook. Keeping it awake with the lid closed is the user's own step (`sudo pmset -a disablesleep 1`). Brain never runs sudo. The README documents this step.

`brain ui` auto-migrates on start (explicit command, per the existing design). Under launchd this means a schema change pulled to `main` is applied at the next restart, after a snapshot.

### 3.4 Configuration

The defaults live in `src/web/config.ts`:

```ts
export const UI_DEFAULTS = { port: 4410, host: '192.168.70.50', allowIps: ['127.0.0.1', '192.168.70.50', '192.168.70.122'] };
```

They are overridable by CLI flags and by the env vars `BRAIN_UI_HOST`, `BRAIN_UI_PORT` and `BRAIN_UI_ALLOW_IPS` (comma-separated). `--host none` disables the LAN listener.

### 3.5 Pre-merge fixes (from the rebase, GOAL-2026-0067)

- **Migration skip edge.** The web-ui migration `0006` keeps an older journal `when` than `0005`. drizzle skips any migration whose `when` is older than the newest applied row. So a DB that applied `0005` but not `0006` would never get `0006`. Fix in `migrateDb`: after drizzle's `migrate`, find the journal entries whose SQL hash is not applied. Then, in one transaction:
  - run their statements (split on `--> statement-breakpoint`);
  - insert a `__drizzle_migrations` row with the hash and `created_at = when`.

  The pre-migration snapshot already covers this path.
- **`scripts/check-migration-on-copy.ts`.** The script checks that goal count, ids, statuses and `rules_version` are unchanged before and after migration. It no longer requires every goal to be at version 0.
- **Brain housekeeping.** GOAL-2026-0010 (original web UI, idle since 28 Sep) is completed or cancelled with a reason, based on its criteria state.

### 3.6 Docs

- **README.** New section "Phone access (Tailscale + LAN)": network path, `install-agent`, the lid-close step, the allowlist and the accepted risk.
- **Web-UI design spec §7.** Update "network access beyond localhost" to point at this spec.

## 4. Error handling

| Condition | Behaviour |
|---|---|
| LAN IP absent | Localhost only; retry every 30 s; logged once per state change |
| Port in use on the LAN address | Log the error; keep localhost; retry with the address check |
| Port in use on localhost | `brain ui` exits non-zero with the reason; launchd restarts it (KeepAlive) |
| Refused source IP | `403 Forbidden source` + rate-limited log line naming the IP |
| `install-agent` when already installed | Boots out the old agent, rewrites the plist, bootstraps again (idempotent) |

## 5. Testing & verification

**Automated (vitest):**
- Allowlist: a request from an allowed IP gets 200 and a refused IP gets 403. IPv4-mapped addresses are normalised. The guard is tested through an injectable `remoteAddress`, because tests cannot bind arbitrary source IPs.
- Host guard and Origin guard keep their existing tests, plus a LAN-host case.
- An absent LAN address gives a localhost-only server, a log line, and a working `/api/goals`. An injectable interface lister drives the "address appears later" case.
- Migration: a DB that applied `0000–0005` but not `0006` gets `0006` from `migrateDb`, its row is recorded, and running `migrateDb` again is a no-op.
- `install-agent --dry-run` prints a plist with caffeinate, KeepAlive and absolute paths.

**Real-world:**
- `brain ui install-agent`, then `launchctl print` shows the agent running.
- From TrueNAS, `curl http://192.168.70.50:4410/` gives 200.
- From another LAN device, the request gets 403, and the log names that device's IP.
- The user opens the URL on the phone with Tailscale on and sees the goal list. If it is refused, the 403 log line shows the real source IP and the allowlist is adjusted.
- `npm test`, `tsc` and `build` pass on `main` after the merge.

## 6. Out of scope (later phases)

Mobile layout and notifications (phase 2), chat with workers (phase 3), diffs and merges (phase 4), login and HTTPS (declined for now, decision 38), and moving to TrueNAS.

## 7. Addendum — phase 1b: Tailscale IP instead of the LAN IP (2026-10-11)

**User decision 42 (GOAL-2026-0070).** Reaching the Mac by its LAN IP needed the `truenas-scale` subnet router in the path. The router rewrote every phone request to TrueNAS's address, so the allowlist could only say "anything behind TrueNAS". The UI now listens on the Mac's own Tailscale IP instead, and the phone connects directly.

| | Phase 1 (above) | Phase 1b (current) |
|---|---|---|
| URL | `http://192.168.70.50:4410` | `http://100.92.71.97:4410` |
| Path | phone → tailnet → TrueNAS subnet router → LAN → Mac | phone → tailnet → Mac |
| Allowlist | `127.0.0.1`, `.50`, `192.168.70.122` | `127.0.0.1`, `100.92.71.97`, `100.80.228.70` (S25 Ultra) |
| Works when | the Mac is on the `.70` LAN and TrueNAS is up | Tailscale is up on both devices |

The design in §3 is unchanged: listening only while the address exists, guard order, and the launchd agent. Only the defaults in `src/web/config.ts` changed. Phase-1 criteria 240 and 241, which were LAN-path checks, are superseded by GOAL-2026-0070's tailnet checks.
