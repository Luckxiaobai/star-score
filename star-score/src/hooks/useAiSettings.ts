import { useCallback, useState } from 'react';
import type { AiProviderConfig } from '../core/ai/types';

const STORAGE_KEY = 'star-score-ai-provider';

const DEFAULT_CONFIG: AiProviderConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  midiModel: 'gpt-4o-mini',
  language: 'zh',
  prompt: '',
  wordTimestamps: true,
};

function loadConfig(): AiProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function useAiSettings() {
  const [config, setConfigState] = useState<AiProviderConfig>(loadConfig);

  const setConfig = useCallback((patch: Partial<AiProviderConfig>) => {
    setConfigState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Local persistence failure does not block the current session.
      }
      return next;
    });
  }, []);

  return { config, setConfig };
}
