/* ================================================================
 * 星谱识音 · Basic Pitch 模块（已迁移）
 * ----------------------------------------------------------------
 * 此模块已迁移到 engines/basicPitchEngine.ts
 * 保留此文件仅为向后兼容（re-export）
 *
 * 新代码请直接 import from './engines' 或 './engines/basicPitchEngine'
 * ================================================================ */

export { BasicPitchEngine, basicPitchNotesToFrames } from './engines/basicPitchEngine';
export { preloadEngines as preloadBasicPitchModel } from './engines/index';

// 类型兼容
export type { EngineResult as BasicPitchResult } from './engines/types';
