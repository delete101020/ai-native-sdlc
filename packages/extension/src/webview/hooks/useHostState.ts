import { useEffect, useRef, useState } from 'react';
import { onHostMessage, postMessage } from '../lib/bridge';
import { applyListDeltas, shareStructure, type ListDelta } from '../lib/hostState';

/**
 * Subscribe to `{ type: 'state', state }` messages from the host.
 * Returns the latest state, seeded from `window.__AIDLC_INITIAL_STATE__`
 * if the host injected it before the React bundle loaded.
 *
 * A message may carry `lists` — lists sent as only their changed items, see
 * `lib/hostState` — and whatever did not change keeps its previous object.
 */
export function useHostState<T>(): T | null {
  const seed = (typeof window !== 'undefined' && (window.__AIDLC_INITIAL_STATE__ as T)) || null;
  const [state, setState] = useState<T | null>(seed);
  const held = useRef<T | null>(seed);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type !== 'state' || msg.state === undefined) { return; }
      const next = applyListDeltas(held.current, msg.state as T, msg.lists as Record<string, ListDelta> | undefined);
      // The host counted on an item this view does not hold. `ready` is what
      // a fresh view says, and every host answers it with the whole state.
      if (!next) { postMessage({ type: 'ready' }); return; }
      held.current = shareStructure(held.current, next);
      setState(held.current);
    });
    // Tell the host we're ready in case it didn't push initial state via window.
    postMessage({ type: 'ready' });
    return off;
  }, []);

  return state;
}
