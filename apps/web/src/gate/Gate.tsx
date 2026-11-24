import { type ReactNode, useEffect, useState } from 'react';
import { type GateOptions, type GateState, loadServerConfig, type ServerConfig } from './config';
import { GATE_MESSAGES } from './messages';
import './gate.css';
import { useClientOutdated } from './outdated';

/** Shows one plain message and nothing else: the gate's states before the app, and the reload text. */
export function GateMessage({ text }: { text: string }) {
  return (
    <main className="gate" role="status">
      <p>{text}</p>
    </main>
  );
}

/**
 * Holds the app back until the server's configuration is known and this client is new enough. While the server is away it says so and tries again;
 * when the client is too old (by the configuration, or by a 426 answer later) it shows the reload text and renders nothing else.
 */
export function Gate({ options, children }: { options: GateOptions; children: (config: ServerConfig) => ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  const outdatedLater = useClientOutdated();
  useEffect(() => {
    const controller = new AbortController();
    void loadServerConfig({ ...options, signal: controller.signal }, setState);
    return () => controller.abort();
    // The options of one gate do not change while it is mounted.
  }, []);
  if (state.kind === 'outdated' || outdatedLater) return <GateMessage text={GATE_MESSAGES.outdated} />;
  if (state.kind === 'unreachable') return <GateMessage text={GATE_MESSAGES.unreachable} />;
  if (state.kind === 'not-ready') return <GateMessage text={GATE_MESSAGES.notReady} />;
  if (state.kind === 'ready') return <>{children(state.config)}</>;
  return null;
}
