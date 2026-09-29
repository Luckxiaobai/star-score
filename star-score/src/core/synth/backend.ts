import { backendRenderProvider, singleSampleProvider } from './registry';
import type {
  SynthNoteInput,
  SynthRequestOptions,
  SynthResult,
} from './types';

export { DEFAULT_SYNTH_BACKEND } from './types';
export type {
  SynthNoteInput,
  SynthRequest,
  SynthRequestOptions,
  SynthResult,
} from './types';

/**
 * 单样本循环合成。
 *
 * 这是当前“喵喵”模式的独立客户端。新增合成模式时，保持相同的
 * SynthResult 返回结构即可复用工作台的状态和播放控件。
 */
export async function synthesizeSingleSample(
  audio: Blob,
  notes: SynthNoteInput[],
  options: SynthRequestOptions = {},
): Promise<SynthResult> {
  return singleSampleProvider.render({
    mode: 'single-sample',
    audio,
    notes,
    ...options,
  });
}

/**
 * 渲染后端当前工程。
 *
 * 与单样本模式返回同一种 SynthResult，工作台不需要知道产物来自
 * 哪个后端端点。
 */
export async function renderBackendProject(
  options: SynthRequestOptions = {},
): Promise<SynthResult> {
  return backendRenderProvider.render({ mode: 'backend-render', ...options });
}
