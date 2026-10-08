/*
 * Data-loading hooks.
 *
 *   const { data, error, loading, reload, setData } = useAsync(fn, deps, { immediate = true, keepPrevious = true })
 *     - runs fn() on mount and whenever deps change; stale responses are discarded
 *     - reload() re-runs it and returns the promise (resolves to data, or undefined on error);
 *       reload({ throwOnError: true }) rejects on error — use that with AsyncButton so it shows "failed"
 *     - keepPrevious keeps the last data visible while a new request loads (no flicker on filter change)
 *
 *   const { data, error, loading, reload, setData, notConnected } = useApi(fn, deps, options)
 *     - same as useAsync, but waits for an API key (notConnected = true, no request sent without one)
 *       and re-fetches automatically after the operator (re)connects
 *
 * Example:
 *   const { data, loading, error, reload } = useApi(() => listInspections(params), [JSON.stringify(params)]);
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';

export function useAsync(fn, deps = [], { immediate = true, keepPrevious = true, enabled = true } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: Boolean(immediate && enabled) });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (opts) => {
    const throwOnError = Boolean(opts && opts.throwOnError === true);
    const id = ++seq.current;
    setState((prev) => ({ data: keepPrevious ? prev.data : undefined, error: null, loading: true }));
    try {
      const data = await fnRef.current();
      if (id === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') return undefined;
      if (id === seq.current) setState((prev) => ({ data: keepPrevious ? prev.data : undefined, error, loading: false }));
      if (throwOnError) throw error;
      return undefined;
    }
  }, [keepPrevious]);

  useEffect(() => {
    if (immediate && enabled) run();
    else if (!enabled) { seq.current += 1; setState({ data: undefined, error: null, loading: false }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  const setData = useCallback((updater) => {
    setState((prev) => ({ ...prev, data: typeof updater === 'function' ? updater(prev.data) : updater }));
  }, []);

  return { ...state, reload: run, setData };
}

export function useApi(fn, deps = [], options = {}) {
  const { hasKey, connectionVersion } = useApp();
  const result = useAsync(fn, [...deps, connectionVersion], { ...options, enabled: hasKey && (options.enabled ?? true) });
  return { ...result, notConnected: !hasKey };
}
