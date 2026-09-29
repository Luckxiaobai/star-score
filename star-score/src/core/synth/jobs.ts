import { readErrorMessage } from './transport';
import type {
  SynthNoteInput,
  SynthRequestOptions,
  SynthJobStatus,
  SynthResult,
} from './types';
import { DEFAULT_SYNTH_BACKEND } from './types';

export interface SynthJobSnapshot {
  id: string;
  kind: string;
  status: SynthJobStatus;
  progress: number;
  message: string;
  result?: {
    wav_size?: number;
    warnings?: number;
    notes?: number;
  } | null;
  error?: string;
  download_url?: string;
}

type JobOptions = SynthRequestOptions;

function abortError(): DOMException {
  return new DOMException('合成任务已取消', 'AbortError');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function cancelRemoteJob(backendUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(`${backendUrl}/api/jobs/${jobId}/cancel`, { method: 'POST' });
  } catch {
    // The polling request already failed or the backend vanished.
  }
}

async function runJob(
  startUrl: string,
  init: RequestInit,
  options: JobOptions,
): Promise<SynthResult> {
  const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
  const signal = options.signal;
  let jobId = '';
  const abortHandler = () => {
    if (jobId) void cancelRemoteJob(backendUrl, jobId);
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const startResp = await fetch(startUrl, { ...init, signal });
    if (!startResp.ok) {
      throw new Error(await readErrorMessage(startResp, '创建合成任务失败'));
    }
    let snapshot = await startResp.json() as SynthJobSnapshot;
    jobId = snapshot.id;

    for (;;) {
      if (signal?.aborted) {
        await cancelRemoteJob(backendUrl, jobId);
        throw abortError();
      }

      options.onProgress?.({
        status: snapshot.status,
        progress: snapshot.progress,
        message: snapshot.message,
      });

      if (snapshot.status === 'succeeded') {
        const downloadResp = await fetch(
          `${backendUrl}/api/jobs/${snapshot.id}/download`,
          { signal },
        );
        if (!downloadResp.ok) {
          throw new Error(await readErrorMessage(downloadResp, '下载合成结果失败'));
        }
        const blob = await downloadResp.blob();
        const result = snapshot.result ?? {};
        return {
          blob,
          warnings: result.warnings ?? 0,
          notes: result.notes,
          wavSize: result.wav_size ?? blob.size,
        };
      }

      if (snapshot.status === 'cancelled') throw abortError();
      if (snapshot.status === 'failed') {
        throw new Error(snapshot.error || '合成任务失败');
      }

      await wait(450, signal);
      const statusResp = await fetch(`${backendUrl}/api/jobs/${snapshot.id}`, { signal });
      if (!statusResp.ok) {
        throw new Error(await readErrorMessage(statusResp, '查询合成任务失败'));
      }
      snapshot = await statusResp.json() as SynthJobSnapshot;
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }
}

export async function startSingleSampleJob(
  audio: Blob,
  notes: SynthNoteInput[],
  options: JobOptions = {},
): Promise<SynthResult> {
  const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
  const form = new FormData();
  form.append('audio', audio, 'sample.wav');
  form.append('notes', JSON.stringify(notes));
  return runJob(
    `${backendUrl}/api/jobs/synth/single-sample`,
    { method: 'POST', body: form },
    options,
  );
}

export async function startBackendRenderJob(
  options: JobOptions = {},
): Promise<SynthResult> {
  const backendUrl = options.backendUrl ?? DEFAULT_SYNTH_BACKEND;
  return runJob(
    `${backendUrl}/api/jobs/render`,
    { method: 'POST' },
    options,
  );
}
