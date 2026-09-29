import { useCallback, useEffect, useRef, useState } from 'react';

export type BackendHealthStatus = 'checking' | 'online' | 'offline';

export interface BackendHealth {
  status: BackendHealthStatus;
  checkedAt: number | null;
  refresh: () => void;
}

/**
 * 后端健康检查。
 *
 * UI 只依赖 online/offline 状态，不在各按钮里重复试探接口。
 */
export function useBackendHealth(url: string, intervalMs = 8000): BackendHealth {
  const [status, setStatus] = useState<BackendHealthStatus>('checking');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const mountedRef = useRef(true);

  const probe = useCallback(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const resp = await fetch(`${url}/health`, { signal: ctrl.signal });
      const data = await resp.json().catch(() => null) as { status?: string } | null;
      if (!mountedRef.current) return;
      setStatus(resp.ok && data?.status === 'ok' ? 'online' : 'offline');
      setCheckedAt(Date.now());
    } catch {
      if (!mountedRef.current) return;
      setStatus('offline');
      setCheckedAt(Date.now());
    } finally {
      clearTimeout(timer);
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- asynchronous external-system probe
    void probe();
    const timer = setInterval(() => void probe(), intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [intervalMs, probe]);

  const refresh = useCallback(() => {
    setStatus('checking');
    void probe();
  }, [probe]);

  return { status, checkedAt, refresh };
}
