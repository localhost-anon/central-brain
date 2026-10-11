import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UiConfig } from './config.js';

/**
 * launchd agent that keeps `brain ui` running on the Mac (phase 1). caffeinate -s keeps the
 * system awake while on AC power; closing a MacBook's lid still sleeps it (user's own pmset step).
 */
export const AGENT_LABEL = 'dev.central-brain.ui';

export interface AgentPaths { node: string; cli: string; plist: string; log: string }

export function defaultAgentPaths(packageRoot: string): AgentPaths {
  return {
    node: process.execPath,
    cli: path.join(packageRoot, 'dist', 'cli', 'index.js'),
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    log: path.join(os.homedir(), '.central-brain', 'logs', 'ui.log'),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function agentArguments(cfg: UiConfig, p: AgentPaths): string[] {
  return [
    '/usr/bin/caffeinate', '-s', p.node, p.cli, 'ui', '--no-open',
    '--host', cfg.host ?? 'none', '--port', String(cfg.port),
    ...cfg.allowIps.flatMap(ip => ['--allow-ip', ip]),
  ];
}

export function buildPlist(cfg: UiConfig, p: AgentPaths, env: Record<string, string>): string {
  const args = agentArguments(cfg, p).map(a => `    <string>${xml(a)}</string>`).join('\n');
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(p.log)}</string>
  <key>StandardErrorPath</key><string>${xml(p.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

/** Workers spawn `claude`; launchd's default PATH would not find it, so the installing shell's PATH is carried over. */
export function agentEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? '/usr/bin:/bin' };
  if (env.BRAIN_DB) out.BRAIN_DB = env.BRAIN_DB;
  return out;
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;
const launchctl = (...args: string[]) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function bootout(): void {
  try { launchctl('bootout', `${domain()}/${AGENT_LABEL}`); } catch { /* not loaded */ }
}

/** Idempotent: an existing agent is booted out and replaced. */
export function installAgent(cfg: UiConfig, p: AgentPaths): { plist: string; log: string } {
  if (!fs.existsSync(p.cli)) throw new Error(`${p.cli} not found — run npm run build first`);
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  bootout();
  fs.writeFileSync(p.plist, buildPlist(cfg, p, agentEnv()));
  launchctl('bootstrap', domain(), p.plist);
  return { plist: p.plist, log: p.log };
}

export function uninstallAgent(p: AgentPaths): { removed: boolean } {
  bootout();
  const existed = fs.existsSync(p.plist);
  if (existed) fs.rmSync(p.plist);
  return { removed: existed };
}

export function agentStatus(): { loaded: boolean; state?: string; pid?: number; lastExitCode?: string } {
  let text: string;
  try { text = launchctl('print', `${domain()}/${AGENT_LABEL}`); } catch { return { loaded: false }; }
  const field = (k: string) => text.match(new RegExp(`^\\s*${k} = (.+)$`, 'm'))?.[1]?.trim();
  const pid = field('pid');
  return { loaded: true, state: field('state'), pid: pid ? Number(pid) : undefined, lastExitCode: field('last exit code') };
}
