import type {
  SynthContext,
  SynthProvider,
  SynthRequest,
  SynthResult,
} from '../types';
import { startSingleSampleJob } from '../jobs';

export const singleSampleProvider: SynthProvider = {
  id: 'single-sample',
  name: '单样本循环',
  description: '同一段人声素材按每个音符自动变调、变速和循环拼接',

  canRun(context: SynthContext) {
    return context.hasMidi && context.hasFrontendSample && context.backendOnline;
  },

  async render(request: SynthRequest): Promise<SynthResult> {
    if (request.mode !== 'single-sample') {
      throw new Error('单样本合成收到不兼容的请求');
    }
    return startSingleSampleJob(request.audio, request.notes, request);
  },
};
