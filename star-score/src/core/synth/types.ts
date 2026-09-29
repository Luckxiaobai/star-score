export const DEFAULT_SYNTH_BACKEND = 'http://127.0.0.1:9874';

export interface SynthNoteInput {
  id: string;
  start: number;
  duration: number;
  pitch: number;
  velocity: number;
  enabled: boolean;
}

export interface SynthResult {
  blob: Blob;
  warnings: number;
  notes?: number;
  wavSize?: number;
}

export type SynthJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface SynthJobProgress {
  status: SynthJobStatus;
  progress: number;
  message: string;
}

export interface SynthRequestOptions {
  signal?: AbortSignal;
  backendUrl?: string;
  onProgress?: (update: SynthJobProgress) => void;
}

export interface SingleSampleSynthRequest extends SynthRequestOptions {
  mode: 'single-sample';
  audio: Blob;
  notes: SynthNoteInput[];
}

export interface BackendRenderSynthRequest extends SynthRequestOptions {
  mode: 'backend-render';
}

export type SynthRequest = SingleSampleSynthRequest | BackendRenderSynthRequest;

export interface SynthContext {
  hasMidi: boolean;
  hasFrontendSample: boolean;
  loadedFromBackend: boolean;
  backendOnline: boolean;
}

export interface SynthProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  canRun(context: SynthContext): boolean;
  render(request: SynthRequest): Promise<SynthResult>;
}
