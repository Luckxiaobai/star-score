import type {
  SynthContext,
  SynthProvider,
  SynthRequest,
  SynthResult,
} from '../types';
import { startBackendRenderJob } from '../jobs';

export const backendRenderProvider: SynthProvider = {
  id: 'backend-render',
  name: '后端工程渲染',
  description: '使用后端当前工程与已恢复素材渲染整轨 WAV',

  canRun(context: SynthContext) {
    return context.loadedFromBackend && context.backendOnline;
  },

  async render(request: SynthRequest): Promise<SynthResult> {
    if (request.mode !== 'backend-render') {
      throw new Error('后端渲染收到不兼容的请求');
    }
    return startBackendRenderJob(request);
  },
};
