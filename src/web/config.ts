/**
 * Phone-access defaults (phase 1, Brain decisions 37–39): the Mac's fixed LAN IP and the
 * only sources allowed to connect — localhost, the Mac itself and the TrueNAS subnet router
 * that Tailscale traffic from the phone arrives through.
 */
export interface UiConfig { port: number; host: string | null; allowIps: string[] }

export const UI_DEFAULTS: UiConfig = {
  port: 4410,
  host: '192.168.70.50',
  allowIps: ['127.0.0.1', '192.168.70.50', '192.168.70.122'],
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
  return { port, host, allowIps };
}
