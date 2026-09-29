import { useCallback, useRef, useState } from 'react';
import { openAICompatibleProvider } from '../core/ai/registry';
import type { AiModelInfo, AiProviderConfig } from '../core/ai/types';

export function useAiModels() {
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (config: AiProviderConfig) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const result = await openAICompatibleProvider.listModels(config, {
        signal: ctrl.signal,
      });
      setModels(result);
      if (result.length === 0) setError('上游没有返回可用模型');
      return result;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : '获取模型失败');
      }
      return [];
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setLoading(false);
    }
  }, []);

  return { models, loading, error, refresh };
}
