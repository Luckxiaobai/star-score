import { DEFAULT_SYNTH_BACKEND } from './types';

export async function readErrorMessage(resp: Response, fallback: string): Promise<string> {
  const data = await resp.json().catch(() => null) as { error?: string } | null;
  return data?.error ?? `${fallback} HTTP ${resp.status}`;
}

export function readCountHeader(resp: Response, name: string): number {
  const value = Number(resp.headers.get(name) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

export function backendUrlOf(value?: string): string {
  return value ?? DEFAULT_SYNTH_BACKEND;
}
