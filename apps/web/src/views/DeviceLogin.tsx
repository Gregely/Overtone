import { useEffect, useRef, useState } from 'react';
import type { DeviceFlowPollDto, DeviceFlowStartDto, DeviceLoginSpec } from '@overtone/shared';
import { useApi } from '../app/context';
import { Icon } from '../ui/Icon';
import { errorMessage } from '../ui/states';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; flow: DeviceFlowStartDto }
  | { kind: 'done'; flowId: string }
  | { kind: 'failed'; message: string };

/**
 * Generic "Log in with <service>" for providers whose configSchema declares
 * `deviceLogin`. Shows the user code + verification link, polls the server,
 * and hands back a flowId to submit with the source (the credentials
 * themselves never reach the browser).
 */
export function DeviceLogin({
  providerId,
  spec,
  signedIn,
  onComplete,
}: {
  providerId: string;
  spec: DeviceLoginSpec;
  /** The saved source already holds credentials from an earlier login. */
  signedIn: boolean;
  onComplete: (flowId: string | null) => void;
}) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const start = async () => {
    setPhase({ kind: 'starting' });
    onComplete(null);
    try {
      const flow = await api.post<DeviceFlowStartDto>(`/api/providers/${providerId}/device-login`);
      setPhase({ kind: 'waiting', flow });
    } catch (err) {
      setPhase({ kind: 'failed', message: errorMessage(err) });
    }
  };

  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const { flow } = phase;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await api.get<DeviceFlowPollDto>(`/api/device-login/${flow.flowId}`);
        if (stopped) return;
        if (r.status === 'complete') {
          setPhase({ kind: 'done', flowId: flow.flowId });
          onCompleteRef.current(flow.flowId);
          return;
        }
        if (r.status === 'expired') return setPhase({ kind: 'failed', message: 'The code expired before it was approved. Try again.' });
        if (r.status === 'denied') return setPhase({ kind: 'failed', message: 'The login was declined.' });
      } catch {
        /* transient; keep polling until the code expires */
      }
      if (Date.now() > Date.parse(flow.expiresAt)) return setPhase({ kind: 'failed', message: 'The code expired before it was approved. Try again.' });
      timer = setTimeout(tick, Math.max(1, flow.intervalSeconds) * 1000);
    };
    let timer = setTimeout(tick, Math.max(1, flow.intervalSeconds) * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, api]);

  return (
    <section className="card stack-sm" aria-labelledby={`dl-${providerId}`} style={{ background: 'var(--surface-2)' }}>
      <h2 id={`dl-${providerId}`} style={{ fontSize: '1rem' }}>
        {spec.label}
      </h2>
      {spec.help && <p className="small muted">{spec.help}</p>}

      <div role="status" aria-live="polite" className="stack-sm">
        {phase.kind === 'waiting' && (
          <>
            <p>
              Go to{' '}
              <a href={phase.flow.verificationUrlComplete ?? phase.flow.verificationUrl} target="_blank" rel="noreferrer noopener">
                {phase.flow.verificationUrl.replace(/^https?:\/\//, '')}
              </a>{' '}
              and enter this code:
            </p>
            <div className="row wrap">
              <code
                aria-label={`Code: ${phase.flow.userCode.split('').join(' ')}`}
                style={{ fontSize: '1.5rem', letterSpacing: '0.15em', fontWeight: 700, padding: '6px 12px', background: 'var(--surface)', borderRadius: 8 }}
              >
                {phase.flow.userCode}
              </code>
              <button
                type="button"
                className="btn small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(phase.flow.userCode);
                    setCopied(true);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>
            <p className="small muted row">
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden="true" /> Waiting for you to approve…
            </p>
          </>
        )}
        {phase.kind === 'done' && (
          <p className="banner ok">
            <Icon name="check" size={18} /> Signed in. Save the source to finish.
          </p>
        )}
        {phase.kind === 'idle' && signedIn && (
          <p className="small">
            <Icon name="check" size={16} /> Signed in via {spec.label.replace(/^Log in with /, '')}.
          </p>
        )}
        {phase.kind === 'failed' && (
          <p className="banner error" role="alert">
            {phase.message}
          </p>
        )}
      </div>

      <div className="row wrap">
        {phase.kind === 'waiting' ? (
          <button type="button" className="btn small ghost" onClick={() => setPhase({ kind: 'idle' })}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => void start()} disabled={phase.kind === 'starting'}>
            {phase.kind === 'starting' ? 'Starting…' : phase.kind === 'done' || signedIn ? 'Log in again' : spec.label}
          </button>
        )}
      </div>
    </section>
  );
}
