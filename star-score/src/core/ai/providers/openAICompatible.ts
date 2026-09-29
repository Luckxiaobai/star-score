import type {
  AiProvider,
  AiProviderConfig,
  AiModelInfo,
  AiTranscribeOptions,
  AiTranscriptionResult,
  MidiGenerationPlan,
  MidiGenerationRequest,
} from '../types';
import { DEFAULT_SYNTH_BACKEND } from '../../synth/types';

async function readError(resp: Response): Promise<string> {
  const data = await resp.json().catch(() => null) as { error?: string; detail?: string } | null;
  return data?.error ?? data?.detail ?? `AI 请求失败 HTTP ${resp.status}`;
}

export const openAICompatibleProvider: AiProvider = {
  id: 'openai-compatible',
  name: 'OpenAI 兼容',

  async transcribe(
    audio: Blob,
    config: AiProviderConfig,
    options: AiTranscribeOptions = {},
  ): Promise<AiTranscriptionResult> {
    const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
    const form = new FormData();
    form.append('audio', audio, 'sample.wav');
    form.append('base_url', config.baseUrl);
    form.append('api_key', config.apiKey);
    form.append('model', config.model);
    form.append('language', config.language);
    form.append('prompt', config.prompt);
    form.append('word_timestamps', String(config.wordTimestamps));

    const resp = await fetch(`${backendUrl}/api/ai/transcribe`, {
      method: 'POST',
      body: form,
      signal: options.signal,
    });
    if (!resp.ok) throw new Error(await readError(resp));
    return resp.json() as Promise<AiTranscriptionResult>;
  },

  async generateMidi(
    config: AiProviderConfig,
    request: MidiGenerationRequest,
    options: AiTranscribeOptions = {},
  ): Promise<MidiGenerationPlan> {
    const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
    const resp = await fetch(`${backendUrl}/api/ai/generate-midi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: config.baseUrl,
        api_key: config.apiKey,
        midi_model: config.midiModel,
        prompt: request.prompt,
        style: request.style,
        bpm: request.bpm,
        bars: request.bars,
        key: request.key,
      }),
      signal: options.signal,
    });
    if (!resp.ok) throw new Error(await readError(resp));
    return resp.json() as Promise<MidiGenerationPlan>;
  },

  async listModels(
    config: AiProviderConfig,
    options: AiTranscribeOptions = {},
  ): Promise<AiModelInfo[]> {
    const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
    const resp = await fetch(`${backendUrl}/api/ai/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: config.baseUrl,
        api_key: config.apiKey,
      }),
      signal: options.signal,
    });
    if (!resp.ok) throw new Error(await readError(resp));
    const data = await resp.json() as { models?: AiModelInfo[] };
    return data.models ?? [];
  },
};
