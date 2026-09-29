import { backendRenderProvider } from './providers/backendRender';
import { singleSampleProvider } from './providers/singleSample';
import type { SynthContext, SynthProvider } from './types';

/**
 * 合成模式注册表。
 *
 * 新增合成模式时：
 *   1. 在 providers/ 下实现 SynthProvider
 *   2. 在这里排序并注册
 *   3. 不修改 HumanVWorkbench 的请求与播放逻辑
 */
export const SYNTH_PROVIDERS: SynthProvider[] = [
  backendRenderProvider,
  singleSampleProvider,
];

export function selectSynthProvider(context: SynthContext): SynthProvider | null {
  return SYNTH_PROVIDERS.find((provider) => provider.canRun(context)) ?? null;
}

export { backendRenderProvider, singleSampleProvider };
