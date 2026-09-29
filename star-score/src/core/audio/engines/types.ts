/* ================================================================
 * 星谱识音 · 引擎适配器统一接口
 * ----------------------------------------------------------------
 * 所有音频识别引擎（Basic Pitch / GAME / YIN / HOMR）都实现此接口。
 * 新增引擎只需实现此接口，在 index.ts 注册即可，业务代码无需改动。
 *
 * 设计原则：
 *   1. 每个引擎是完全独立的模块，互不依赖
 *   2. 引擎可以随时增删，不影响其他引擎
 *   3. 上游更新时只需替换对应引擎文件，接口不变
 *   4. 引擎管理器按优先级自动调度，业务层无感知
 * ================================================================ */

import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';

/** 引擎能力描述 */
export interface EngineCapabilities {
  /** 是否支持歌声识别（针对人声优化） */
  singingVoice: boolean;
  /** 是否支持多音（和弦/多乐器同时识别） */
  polyphonic: boolean;
  /** 是否支持弯音检测 */
  pitchBend: boolean;
  /** 是否需要后端服务 */
  requiresBackend: boolean;
  /** 是否在浏览器端运行 */
  browserNative: boolean;
  /** 输入类型 */
  inputType: 'audio' | 'image';
}

/** 引擎分析结果 */
export interface EngineResult {
  /** 识别到的音符列表 */
  notes: DetectedNote[];
  /** 音频总时长（秒） */
  duration: number;
  /** 帧数（用于节拍/调号估计的兼容帧） */
  frameCount: number;
  /** 引擎名称 */
  engineName: string;
  /** 引擎版本（方便排查兼容性） */
  engineVersion: string;
}

/**
 * 引擎适配器接口
 * 每个引擎实现此接口，由 EngineManager 统一调度
 */
export interface AudioEngineAdapter {
  /** 引擎唯一标识 */
  readonly id: string;
  /** 引擎显示名称 */
  readonly name: string;
  /** 引擎版本号 */
  readonly version: string;
  /** 引擎能力描述 */
  readonly capabilities: EngineCapabilities;

  /**
   * 检测引擎是否可用
   * - 浏览器引擎：检查模型是否加载成功
   * - 后端引擎：检查后端服务是否在线
   */
  isAvailable(): Promise<boolean>;

  /**
   * 分析音频，输出音符列表
   * @param audio 音频 Blob
   * @param onProgress 进度回调
   * @param options 引擎特定选项
   */
  analyze(
    audio: Blob,
    onProgress?: ProgressCallback,
    options?: Record<string, unknown>
  ): Promise<EngineResult>;

  /**
   * 预加载（可选）
   * 浏览器引擎可预加载模型，后端引擎可预热连接
   */
  preload?(): Promise<void>;
}

/** 引擎优先级（数字越大优先级越高） */
export const ENGINE_PRIORITY = {
  game: 100,        // GAME: 歌声精度最高，但需要后端
  basicPitch: 80,   // Basic Pitch: 浏览器端，通用
  yin: 50,          // YIN: 永远可用，最后兜底
  homr: 100,        // HOMR: 图片识谱，不同输入类型
} as const;
