import type { DeviceStats, Punch } from './device';
import { errMsg } from './errors';

const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_PUNCHES_PER_REQUEST = 1000;

export class CrmError extends Error {
  /** HTTP status, or null for network errors and timeouts. */
  readonly status: number | null;
  /** A 4xx (except 408/429) means retrying the same request will not help: bad key, bad payload... */
  readonly permanent: boolean;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.permanent = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

export interface PunchesResponse {
  accepted: number;
  duplicates: number;
}

export interface HeartbeatBody {
  deviceOnline: boolean;
  pendingPunches: number;
  bridgeVersion: string;
  stats: DeviceStats | null;
}

export interface CrmCommand {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface CommandAck {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Talks to the CRM's /device-api/*. Outbound HTTPS only. */
export class CrmClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly deviceKey: string,
    private readonly version: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async postPunches(punches: readonly Punch[]): Promise<PunchesResponse> {
    if (punches.length > MAX_PUNCHES_PER_REQUEST) {
      throw new Error(`At most ${MAX_PUNCHES_PER_REQUEST} punches per request (got ${punches.length})`);
    }
    const body = await this.request('POST', '/device-api/punches', { punches });
    const o = asObject(body);
    return { accepted: num(o?.accepted), duplicates: num(o?.duplicates) };
  }

  async heartbeat(hb: HeartbeatBody): Promise<void> {
    await this.request('POST', '/device-api/heartbeat', hb);
  }

  async getCommands(): Promise<CrmCommand[]> {
    const body = asObject(await this.request('GET', '/device-api/commands'));
    if (!body || !Array.isArray(body.commands)) {
      throw new CrmError('CRM GET /device-api/commands: response has no "commands" array', null);
    }
    const out: CrmCommand[] = [];
    for (const c of body.commands) {
      const o = asObject(c);
      const id = o?.id;
      if (typeof id !== 'string' && typeof id !== 'number') continue; // can't ack it without an id
      out.push({
        id: String(id),
        type: typeof o?.type === 'string' ? o.type : '',
        payload: asObject(o?.payload),
      });
    }
    return out;
  }

  async ackCommand(id: string, ack: CommandAck): Promise<void> {
    await this.request('POST', `/device-api/commands/${encodeURIComponent(id)}/ack`, ack);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const label = `CRM ${method} ${path}`;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'x-device-key': this.deviceKey,
          'content-type': 'application/json',
          'user-agent': `zk-bridge/${this.version}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new CrmError(`${label}: ${timedOut ? `no response within ${REQUEST_TIMEOUT_MS / 1000} s` : errMsg(e)}`, null);
    }

    let text = '';
    try {
      text = await res.text();
    } catch {
      /* body unreadable; status still tells us what happened */
    }

    if (!res.ok) {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new CrmError(`${label}: HTTP ${res.status} ${res.statusText}${snippet ? ` - ${snippet}` : ''}`, res.status);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null; // a 2xx is what counts; the body is informational
    }
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
