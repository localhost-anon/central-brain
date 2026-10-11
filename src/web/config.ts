import { isIP } from 'node:net';

/**
 * Phone-access defaults (phase 1b, Brain decision 42): the UI also listens on the Mac's own
 * Tailscale IP, so the phone connects directly over the tailnet (no subnet router, no SNAT).
 * Only localhost, the Mac itself and the phone's tailnet IP may connect.
 */
export interface UiConfig { port: number; host: string | null; allowIps: string[] }

export const UI_DEFAULTS: UiConfig = {
  port: 4410,
  host: '100.92.71.97', // pankajs-macbook-air
  allowIps: ['127.0.0.1', '100.92.71.97', '100.80.228.70'], // localhost, the Mac, pankajs-s25-ultra
};

/** `::ffff:a.b.c.d` (IPv4-mapped IPv6, how node reports IPv4 peers on dual-stack sockets) → `a.b.c.d`. */
export function normaliseIp(ip: string | undefined): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

/** Flags win over env vars, env vars over defaults. An explicit allowlist replaces the default; 127.0.0.1 is always kept. */
export function resolveUiConfig(
  flags: { port?: string | number; host?: string; allowIp?: string[] },
  env: Record<string, string | undefined> = process.env,
): UiConfig {
  const port = Number(flags.port ?? env.BRAIN_UI_PORT ?? UI_DEFAULTS.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${flags.port ?? env.BRAIN_UI_PORT}`);
  const hostRaw = flags.host ?? env.BRAIN_UI_HOST ?? UI_DEFAULTS.host;
  const host = hostRaw === 'none' || hostRaw === '' ? null : hostRaw;
  const explicit = flags.allowIp?.length ? flags.allowIp : env.BRAIN_UI_ALLOW_IPS ? list(env.BRAIN_UI_ALLOW_IPS) : null;
  const allowIps = explicit ? ['127.0.0.1', ...explicit.map(normaliseIp).filter(ip => ip !== '127.0.0.1')] : [...UI_DEFAULTS.allowIps];
  // An empty or malformed entry would match an unknown peer (''), so every entry must be a real IP.
  for (const ip of allowIps) if (!isIP(ip)) throw new Error(`Invalid --allow-ip / BRAIN_UI_ALLOW_IPS entry: "${ip}"`);
  if (host && !isIP(host)) throw new Error(`Invalid --host / BRAIN_UI_HOST: "${host}" (an IP address or "none")`);
  return { port, host, allowIps };
}
