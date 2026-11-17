import { isIP } from 'node:net';

export type FsyncPolicy = 'always' | 'everysec' | 'no';

export interface Address {
  host: string;
  port: number;
}

export interface RespkvConfig {
  /** Where the RESP server listens. Port 0 picks a free port. */
  listen: Address;
  /** When set, clients must AUTH first. */
  password: string;
  /** Path of the append-only file. Empty turns persistence off. */
  aofPath: string;
  /** When the AOF is forced to stable storage, as Redis's appendfsync. */
  appendfsync: FsyncPolicy;
  maxClients: number;
  /** A client whose socket stays unwritable this long is dropped. */
  writeTimeoutMs: number;
  /** A subscriber further behind than this is dropped. */
  maxOutboxBytes: number;
  /** Unparsed input one connection may hold. */
  maxQueryBytes: number;
  /** Where the HTTP health and stats endpoints listen, or null for nowhere. */
  admin: Address | null;
}

export const RESPKV_CONFIG = Symbol('RESPKV_CONFIG');

export const DEFAULT_CONFIG: RespkvConfig = {
  listen: { host: '127.0.0.1', port: 6380 },
  password: '',
  aofPath: '',
  appendfsync: 'everysec',
  maxClients: 10_000,
  writeTimeoutMs: 30_000,
  maxOutboxBytes: 32 * 1024 * 1024,
  maxQueryBytes: 1024 * 1024 * 1024,
  admin: { host: '127.0.0.1', port: 6381 },
};

/**
 * Reads the configuration from environment variables, all optional:
 *
 * - RESPKV_ADDR: host:port to listen on (127.0.0.1:6380)
 * - RESPKV_PASSWORD: require AUTH with this password
 * - RESPKV_AOF: path of the append-only file (persistence off when unset)
 * - RESPKV_APPENDFSYNC: always, everysec or no (everysec)
 * - RESPKV_MAXCLIENTS: connection limit (10000)
 * - RESPKV_ADMIN_ADDR: host:port for HTTP health and stats, or "off"
 *   (127.0.0.1:6381)
 *
 * Throws on a malformed value instead of falling back to a default, because a
 * typo in, say, the fsync policy would otherwise silently weaken durability.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RespkvConfig {
  const cfg: RespkvConfig = { ...DEFAULT_CONFIG };
  if (env.RESPKV_ADDR)
    cfg.listen = parseAddress('RESPKV_ADDR', env.RESPKV_ADDR);
  if (env.RESPKV_PASSWORD) cfg.password = env.RESPKV_PASSWORD;
  if (env.RESPKV_AOF) cfg.aofPath = env.RESPKV_AOF;
  if (env.RESPKV_APPENDFSYNC) {
    const p = env.RESPKV_APPENDFSYNC.toLowerCase();
    if (p !== 'always' && p !== 'everysec' && p !== 'no') {
      throw new Error(
        `RESPKV_APPENDFSYNC: unknown policy "${env.RESPKV_APPENDFSYNC}" (want always, everysec or no)`,
      );
    }
    cfg.appendfsync = p;
  }
  if (env.RESPKV_MAXCLIENTS) {
    const n = Number(env.RESPKV_MAXCLIENTS);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `RESPKV_MAXCLIENTS: want a positive integer, got "${env.RESPKV_MAXCLIENTS}"`,
      );
    }
    cfg.maxClients = n;
  }
  if (env.RESPKV_ADMIN_ADDR) {
    cfg.admin =
      env.RESPKV_ADMIN_ADDR === 'off'
        ? null
        : parseAddress('RESPKV_ADMIN_ADDR', env.RESPKV_ADMIN_ADDR);
  }
  return cfg;
}

function parseAddress(name: string, value: string): Address {
  const i = value.lastIndexOf(':');
  const port = Number(value.slice(i + 1));
  let host = i < 0 ? '' : value.slice(0, i);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (i < 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name}: want host:port, got "${value}"`);
  }
  return { host: host || '0.0.0.0', port };
}

/** Reports whether host only accepts connections from this machine. */
export function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}
