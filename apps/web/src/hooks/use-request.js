import { useEffect, useState } from 'react';

export function useRequest(load, args, enabled = true) {
  const key = JSON.stringify(args);
  const [state, setState] = useState({ key: null, data: null, error: null, loading: true });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ key, data: null, error: null, loading: true });
    load(...JSON.parse(key), controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, data, error: null, loading: false }); },
      (error) => { if (!controller.signal.aborted) setState({ key, data: null, error, loading: false }); },
    );
    return () => controller.abort();
  }, [key, load, enabled]);
  return state.key === key ? state : { data: null, error: null, loading: enabled };
}
