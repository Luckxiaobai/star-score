export interface AiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  midiModel: string;
  language: string;
  prompt: string;
  wordTimestamps: boolean;
}

export interface LyricUnit {
  text: string;
  start: number;
  end: number;
}

export interface AiTranscriptionResult {
  text: string;
  segments: LyricUnit[];
  words: LyricUnit[];
  provider: string;
  model: string;
}

export interface GeneratedMidiNote {
  start_beat: number;
  duration_beats: number;
  pitch: number;
  velocity: number;
  lyric?: string;
}

export interface MidiGenerationPlan {
  title: string;
  bpm: number;
  time_signature: [number, number];
  bars: number;
  notes: GeneratedMidiNote[];
  provider: string;
  model: string;
}

export interface MidiGenerationRequest {
  prompt: string;
  style: string;
  bpm: number;
  bars: number;
  key: string;
}

export interface AiTranscribeOptions {
  signal?: AbortSignal;
  backendUrl?: string;
}

export interface AiModelInfo {
  id: string;
  name: string;
}

export interface AiProvider {
  readonly id: string;
  readonly name: string;
  transcribe(
    audio: Blob,
    config: AiProviderConfig,
    options?: AiTranscribeOptions,
  ): Promise<AiTranscriptionResult>;
  generateMidi(
    config: AiProviderConfig,
    request: MidiGenerationRequest,
    options?: AiTranscribeOptions,
  ): Promise<MidiGenerationPlan>;
  listModels(
    config: AiProviderConfig,
    options?: AiTranscribeOptions,
  ): Promise<AiModelInfo[]>;
}
