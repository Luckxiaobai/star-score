import type { CommandPaletteItem } from '../../components/humanv/CommandPalette';

export interface HumanVCommandContext {
  hasMidi: boolean;
  hasSample: boolean;
  backendOnline: boolean;
  synthBusy: boolean;
  synthProviderName?: string;
  isPlaying: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedCount: number;
  snapDivision: 'off' | '4' | '8' | '16';
  hasAiResult: boolean;
  aiBusy: boolean;
  hasAiMidiPlan: boolean;
  importMidi: () => void;
  uploadSample: () => void;
  openProject: () => void;
  saveProject: () => void;
  exportMidi: () => void;
  generate: () => void;
  togglePlayback: () => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  deleteSelected: () => void;
  transpose: (semitones: number) => void;
  quantize: () => void;
  adjustVelocity: (delta: number) => void;
  toggleEnabled: () => void;
  toScore: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;
  openAi: () => void;
  transcribeAi: () => void;
  applyAiLyrics: () => void;
  openAiMidi: () => void;
  applyAiMidi: () => void;
}

export function buildHumanVCommands(context: HumanVCommandContext): CommandPaletteItem[] {
  const canGenerate = context.hasMidi
    && context.hasSample
    && context.backendOnline
    && !context.synthBusy;
  const hasSelection = context.selectedCount > 0;

  return [
    {
      id: 'import-midi',
      label: '导入 MIDI',
      group: '文件',
      keywords: 'open load mid midi',
      run: context.importMidi,
    },
    {
      id: 'upload-sample',
      label: context.hasSample ? '更换人声素材' : '上传人声素材',
      group: '文件',
      keywords: 'audio wav sample 喵喵',
      run: context.uploadSample,
    },
    {
      id: 'open-ai-lyrics',
      label: '打开 AI 歌词面板',
      group: 'AI',
      keywords: 'whisper asr 歌词 识别 对齐',
      run: context.openAi,
    },
    {
      id: 'ai-transcribe',
      label: 'AI 识别歌词',
      group: 'AI',
      disabled: !context.hasSample || !context.backendOnline || context.aiBusy,
      run: context.transcribeAi,
    },
    {
      id: 'apply-ai-lyrics',
      label: '把 AI 歌词对齐到音符',
      group: 'AI',
      disabled: !context.hasMidi || !context.hasAiResult,
      run: context.applyAiLyrics,
    },
    {
      id: 'open-ai-midi',
      label: 'AI 生成 MIDI',
      group: 'AI',
      keywords: 'prompt compose midi 作曲 生成',
      run: context.openAiMidi,
    },
    {
      id: 'apply-ai-midi',
      label: '把 AI MIDI 写入工作台',
      group: 'AI',
      disabled: !context.hasAiMidiPlan,
      run: context.applyAiMidi,
    },
    {
      id: 'open-project',
      label: '打开工程',
      group: '文件',
      disabled: !context.backendOnline,
      run: context.openProject,
    },
    {
      id: 'save-project',
      label: '保存工程',
      group: '文件',
      shortcut: 'Ctrl+S',
      disabled: !context.hasMidi || !context.backendOnline,
      run: context.saveProject,
    },
    {
      id: 'export-midi',
      label: '导出清理后的 MIDI',
      group: '导出',
      disabled: !context.hasMidi,
      run: context.exportMidi,
    },
    {
      id: 'generate-synth',
      label: context.synthProviderName
        ? `生成合成（${context.synthProviderName}）`
        : '生成合成',
      group: '合成',
      disabled: !canGenerate,
      run: context.generate,
    },
    {
      id: 'play-midi',
      label: context.isPlaying ? '停止 MIDI 预览' : '播放 MIDI 预览',
      group: '播放',
      shortcut: 'Space',
      disabled: !context.hasMidi,
      run: context.togglePlayback,
    },
    {
      id: 'undo',
      label: '撤销编辑',
      group: '编辑',
      shortcut: 'Ctrl+Z',
      disabled: !context.canUndo,
      run: context.undo,
    },
    {
      id: 'redo',
      label: '重做编辑',
      group: '编辑',
      shortcut: 'Ctrl+Y',
      disabled: !context.canRedo,
      run: context.redo,
    },
    {
      id: 'select-all',
      label: '选择全部音符',
      group: '编辑',
      shortcut: 'Ctrl+A',
      disabled: !context.hasMidi,
      run: context.selectAll,
    },
    {
      id: 'delete-selected',
      label: '删除选中音符',
      group: '编辑',
      shortcut: 'Delete',
      disabled: !hasSelection,
      run: context.deleteSelected,
    },
    {
      id: 'transpose-up',
      label: '选中音符升高一个八度',
      group: '编辑',
      disabled: !hasSelection,
      run: () => context.transpose(12),
    },
    {
      id: 'transpose-down',
      label: '选中音符降低一个八度',
      group: '编辑',
      disabled: !hasSelection,
      run: () => context.transpose(-12),
    },
    {
      id: 'quantize-selected',
      label: `按 1/${context.snapDivision === 'off' ? '16' : context.snapDivision} 量化选中音符`,
      group: '编辑',
      disabled: !hasSelection || context.snapDivision === 'off',
      run: context.quantize,
    },
    {
      id: 'velocity-up',
      label: '选中音符力度 +10',
      group: '编辑',
      disabled: !hasSelection,
      run: () => context.adjustVelocity(10),
    },
    {
      id: 'velocity-down',
      label: '选中音符力度 -10',
      group: '编辑',
      disabled: !hasSelection,
      run: () => context.adjustVelocity(-10),
    },
    {
      id: 'toggle-enabled',
      label: '启用 / 停用选中音符',
      group: '编辑',
      disabled: !hasSelection,
      run: context.toggleEnabled,
    },
    {
      id: 'to-score',
      label: '生成简谱',
      group: '导出',
      disabled: !context.hasMidi,
      run: context.toScore,
    },
    {
      id: 'zoom-in',
      label: '放大钢琴卷帘',
      group: '视图',
      disabled: !context.hasMidi,
      run: context.zoomIn,
    },
    {
      id: 'zoom-out',
      label: '缩小钢琴卷帘',
      group: '视图',
      disabled: !context.hasMidi,
      run: context.zoomOut,
    },
    {
      id: 'fit-view',
      label: '适配全部音符',
      group: '视图',
      disabled: !context.hasMidi,
      run: context.fitView,
    },
  ];
}
