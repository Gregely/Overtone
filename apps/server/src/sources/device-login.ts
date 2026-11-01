import { randomBytes } from 'node:crypto';
import type { DeviceFlowPollDto, DeviceFlowStartDto } from '@overtone/shared';
import { ApiError } from '../http/errors.js';
import { createProviderFetch } from '../http/provider-fetch.js';
import { createRedactingLogger, type BaseLogger } from '../http/redact.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { DeviceFlowContext } from '../providers/types.js';

interface Flow {
  id: string;
  providerId: string;
  userId: number;
  handle: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  status: DeviceFlowPollDto['status'];
  secrets?: Record<string, string>;
}

export interface DeviceLoginDeps {
  registry: ProviderRegistry;
  logger: BaseLogger;
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const KEEP_AFTER_MS = 15 * 60_000;
const MAX_FLOWS = 50;

/**
 * Runs provider device / PIN logins ("Log in with …") on behalf of the UI.
 * The opaque provider handle and the resulting credentials stay on the
 * server; the client only ever sees a flowId, the user code and the
 * verification URL. Completed credentials are consumed when the source is
 * saved (`take`) and are otherwise forgotten after 15 minutes.
 */
export class DeviceLoginService {
  readonly #flows = new Map<string, Flow>();
  constructor(private readonly d: DeviceLoginDeps) {}

  #now(): number {
    return this.d.now?.() ?? Date.now();
  }

  #ctx(signal: AbortSignal, secrets: () => string[]): DeviceFlowContext {
    const logger = createRedactingLogger(this.d.logger, secrets);
    return { signal, logger, fetch: createProviderFetch({ userAgent: this.d.userAgent, logger, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) }) };
  }

  #gc(): void {
    const now = this.#now();
    for (const [id, f] of this.#flows) if (now > f.expiresAt + KEEP_AFTER_MS) this.#flows.delete(id);
  }

  async start(providerId: string, userId: number): Promise<DeviceFlowStartDto> {
    this.#gc();
    const plugin = this.d.registry.get(providerId);
    const handler = plugin?.manifest.deviceFlow;
    if (!handler) throw ApiError.badRequest('This provider has no "Log in with…" option');
    if (this.#flows.size >= MAX_FLOWS) throw new ApiError(429, 'too_many_logins', 'Too many logins in progress; try again in a few minutes');
    let s;
    try {
      s = await handler.start(this.#ctx(AbortSignal.timeout(20_000), () => []));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('unavailable', `${plugin.manifest.name}: couldn't start the login`, { cause: err });
    }
    const id = randomBytes(16).toString('base64url');
    const intervalMs = Math.max(1, s.intervalSeconds) * 1000;
    this.#flows.set(id, {
      id,
      providerId,
      userId,
      handle: s.handle,
      expiresAt: s.expiresAt.getTime(),
      intervalMs,
      nextPollAt: this.#now() + intervalMs,
      status: 'pending',
    });
    return {
      flowId: id,
      userCode: s.userCode,
      verificationUrl: s.verificationUrl,
      ...(s.verificationUrlComplete ? { verificationUrlComplete: s.verificationUrlComplete } : {}),
      expiresAt: s.expiresAt.toISOString(),
      intervalSeconds: intervalMs / 1000,
    };
  }

  /** Poll the provider (no more often than its interval; extra calls return the last state). */
  async poll(flowId: string, userId: number): Promise<DeviceFlowPollDto> {
    const flow = this.#get(flowId, userId);
    if (flow.status !== 'pending') return { status: flow.status };
    const now = this.#now();
    if (now > flow.expiresAt) {
      flow.status = 'expired';
      return { status: 'expired' };
    }
    if (now < flow.nextPollAt) return { status: 'pending' };
    flow.nextPollAt = now + flow.intervalMs;
    const handler = this.d.registry.get(flow.providerId)?.manifest.deviceFlow;
    if (!handler) throw ApiError.notFound('Login');
    try {
      const r = await handler.poll(flow.handle, this.#ctx(AbortSignal.timeout(20_000), () => Object.values(flow.secrets ?? {})));
      if (r.status === 'complete') {
        flow.secrets = r.secrets;
        flow.status = 'complete';
      } else {
        flow.status = r.status;
      }
    } catch (err) {
      // Transient upstream problems: keep waiting; the flow's own expiry ends it.
      if (err instanceof ProviderError && err.code === 'auth') flow.status = 'denied';
      else this.d.logger.warn({ provider: flow.providerId, error: (err as Error).message }, 'device login poll failed');
    }
    return { status: flow.status };
  }

  /** Credentials from a completed login. `consume` removes them (on save). */
  credentials(flowId: string, providerId: string, userId: number, consume: boolean): Record<string, string> {
    const flow = this.#get(flowId, userId);
    if (flow.providerId !== providerId) throw ApiError.badRequest('This login belongs to a different provider');
    if (flow.status !== 'complete' || !flow.secrets) throw ApiError.validation({ deviceLogin: 'Login not completed yet' });
    const secrets = flow.secrets;
    if (consume) this.#flows.delete(flowId);
    return secrets;
  }

  #get(flowId: string, userId: number): Flow {
    this.#gc();
    const flow = this.#flows.get(flowId);
    if (!flow || flow.userId !== userId) throw ApiError.notFound('Login');
    return flow;
  }
}
