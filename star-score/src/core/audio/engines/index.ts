/* ================================================================
 * 星谱识音 · 引擎管理器
 * ----------------------------------------------------------------
 * 统一管理所有识别引擎，按优先级自动调度。
 *
 * 调度策略：
 *   音频输入：
 *     1. 检查 GAME 后端是否在线 → 用 GAME（歌声精度最高）
 *     2. 否则检查 Basic Pitch 模型是否可用 → 用 Basic Pitch
 *     3. 最后兜底 → 用 YIN（永远可用）
 *   图片输入：
 *     1. 检查 HOMR 后端是否在线 → 用 HOMR
 *     2. 否则提示"需要后端服务"
 *
 * 新增引擎步骤：
 *   1. 在 engines/ 下创建新引擎文件，实现 AudioEngineAdapter 接口
 *   2. 在此处 import 并注册到 ENGINE_REGISTRY
 *   3. 在 ENGINE_PRIORITY 中设置优先级
 *   4. 完成，业务代码无需任何改动
 *
 * 上游更新步骤：
 *   - npm 引擎：npm update 对应包，替换 public/models 下的模型文件
 *   - 后端引擎：后端更新 pip 包 / ONNX 模型文件
 *   - 前端适配器文件只在接口结构变化时才需修改
 * ================================================================ */

import type { AudioEngineAdapter, EngineResult } from './types';
import type { ProgressCallback } from '../decode';
import { TranscribeEngine } from './transcribeEngine';
import { BasicPitchEngine } from './basicPitchEngine';
import { YinEngine } from './yinEngine';
import { GameEngine } from './gameEngine';
import { HomrEngine } from './homrEngine';

export type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
export { TranscribeEngine } from './transcribeEngine';
export { BasicPitchEngine } from './basicPitchEngine';
export { YinEngine } from './yinEngine';
export { GameEngine } from './gameEngine';
export { HomrEngine } from './homrEngine';

/* ================================================================
 * 引擎注册表
 * 每个引擎实例化一次，全局复用
 * ================================================================ */

/** 音频引擎列表（按优先级排序，索引越小优先级越高） */
const audioEngines: AudioEngineAdapter[] = [
  new TranscribeEngine(),  // 全链路：分离→GAME→music21，准确度最高
  new GameEngine(),        // 仅 GAME 歌声转录（后端）
  new BasicPitchEngine(),  // 浏览器端通用多音
  new YinEngine(),         // 兜底
];

/** 图片引擎列表 */
const imageEngines: AudioEngineAdapter[] = [
  new HomrEngine(),        // 唯一的图片引擎
];

/** 后端引擎实例引用（方便动态配置地址） */
export const transcribeEngine = audioEngines[0] as TranscribeEngine;
export const gameEngine = audioEngines[1] as GameEngine;
export const homrEngine = imageEngines[0] as HomrEngine;
export const basicPitchEngine = audioEngines[2] as BasicPitchEngine;

/* ================================================================
 * 引擎管理器 API
 * ================================================================ */

/** 后端配置（单一配置源见 core/audio/backendConfig.ts） */
let backendUrl = 'http://127.0.0.1:9874';

/** 更新后端地址（影响 GAME 和 HOMR 引擎） */
export function setBackendUrl(url: string): void {
  backendUrl = url;
  transcribeEngine.setBaseUrl(url);
  gameEngine.setBaseUrl(url);
  homrEngine.setBaseUrl(url);
}

/** 获取当前后端地址 */
export function getBackendUrl(): string {
  return backendUrl;
}

/**
 * 选择最佳可用引擎
 * 按优先级依次检测，返回第一个可用的引擎
 */
async function selectEngine(
  inputType: 'audio' | 'image'
): Promise<{ engine: AudioEngineAdapter; available: AudioEngineAdapter[] }> {
  const engines = inputType === 'audio' ? audioEngines : imageEngines;
  const available: AudioEngineAdapter[] = [];

  for (const engine of engines) {
    try {
      const ok = await engine.isAvailable();
      if (ok) {
        return { engine, available };
      }
    } catch {
      // 引擎检测失败，跳过
    }
  }

  // 所有引擎都不可用，如果音频类型则返回 YIN（永远可用）
  if (inputType === 'audio') {
    const yin = audioEngines[audioEngines.length - 1]; // YEngine
    return { engine: yin, available };
  }

  throw new Error('没有可用的图片识别引擎，请启动后端服务');
}

/**
 * 使用最佳引擎分析音频
 * 自动选择引擎，业务层无需关心用哪个
 */
export async function analyzeAudioWithBestEngine(
  audio: Blob,
  onProgress?: ProgressCallback,
  options?: { language?: string; forceYIN?: boolean; engineOptions?: Record<string, unknown> }
): Promise<EngineResult & { engineId: string }> {
  // 强制使用 YIN（调试用）
  if (options?.forceYIN) {
    const yin = audioEngines[audioEngines.length - 1];
    const result = await yin.analyze(audio, onProgress);
    return { ...result, engineId: yin.id };
  }

  const { engine } = await selectEngine('audio');
  const result = await engine.analyze(audio, onProgress, {
    language: options?.language,
    ...(options?.engineOptions ?? {}),
  });
  return { ...result, engineId: engine.id };
}

/**
 * 使用 HOMR 识别图片
 */
export async function recognizeImageWithBestEngine(
  image: Blob,
  onProgress?: ProgressCallback
): Promise<EngineResult & { engineId: string }> {
  const { engine } = await selectEngine('image');
  const result = await engine.analyze(image, onProgress);
  return { ...result, engineId: engine.id };
}

/**
 * 检测所有引擎的可用性状态
 * 返回每个引擎的在线状态，供 UI 展示
 */
export async function checkEngineStatus(): Promise<{
  id: string;
  name: string;
  available: boolean;
  requiresBackend: boolean;
}[]> {
  const all = [...audioEngines, ...imageEngines];
  return Promise.all(
    all.map(async (engine) => ({
      id: engine.id,
      name: engine.name,
      available: await engine.isAvailable().catch(() => false),
      requiresBackend: engine.capabilities.requiresBackend,
    }))
  );
}

/**
 * 预加载浏览器端引擎模型
 * 可在用户上传文件前预热，加快首次识别
 */
export async function preloadEngines(): Promise<void> {
  try {
    await basicPitchEngine.preload?.();
  } catch {
    // 预加载失败不影响后续使用
  }
}
