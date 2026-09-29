# 星谱识音 · StarScore

音频识别简谱工具：上传/播放音频 → 自动识别音高、节拍、调号 → 生成可编辑简谱（1234567）。

---

## 一、快速启动（两种方式）

### 开发模式（改代码即时生效，日常开发用这个）
双击 **`启动-开发模式.bat`** → 自动装依赖 → 启动 dev server → 自动打开浏览器。

### 绿色版（构建后双击即用）
1. 双击 **`构建-绿色版.bat`**（把代码打包到 `dist/`）
2. 双击 **`启动星谱识音.bat`** → 本地起服务并自动打开浏览器

> 绿色版只依赖 Node（不需要 npm install），首次没有 `dist` 时会自动构建。

---

## 二、目录分区（清晰好改）

```
star-score/
├─ src/
│  ├─ types/
│  │  └─ score.ts              # 数据模型：Note / Measure / Score
│  ├─ core/                    # 纯逻辑，不碰 UI
│  │  ├─ audio/                # ★ 音频识别（准确度核心）
│  │  │  ├─ fft.ts             # 基-2 FFT / IFFT / Hann / 幅度谱
│  │  │  ├─ decode.ts          # 解码 + 混单声道 + 降采样到 22.05kHz
│  │  │  ├─ pitch.ts           # YIN 基频检测（FFT 加速版）
│  │  │  ├─ track.ts           # 逐帧音高轨迹 + 谱通量 + 中值滤波
│  │  │  ├─ segment.ts         # 音符分割（间隙容错 + 音高跳变）
│  │  │  ├─ tempo.ts           # 自相关节拍估计 + 倍频校正
│  │  │  └─ key.ts             # Krumhansl-Schmuckler 调号估计
│  │  ├─ theory/
│  │  │  └─ musicTheory.ts     # MIDI/频率、移调、时值、拍数
│  │  └─ engine/
│  │     └─ AudioEngine.ts     # Web Audio 播放引擎
│  ├─ pipeline/
│  │  └─ analyze.ts            # ★ 识别流水线编排 + 简谱转换
│  ├─ components/              # UI：Toolbar / ScoreRenderer / Sidebar / AudioImport
│  ├─ hooks/
│  │  └─ useScore.ts           # 谱面状态管理（撤销/重做/自动保存）
│  ├─ utils/
│  │  └─ exporters.ts          # JSON / MIDI / PDF 导出
│  └─ styles/
├─ scripts/
│  └─ serve.mjs                # 绿色版本地静态服务器（仅 Node 内置模块）
├─ 启动-开发模式.bat
├─ 构建-绿色版.bat
└─ 启动星谱识音.bat
```

**改哪里一目了然**：
- 识别不准 → `core/audio/` + `pipeline/analyze.ts`
- 简谱显示 → `components/ScoreRenderer.tsx` + `styles/score.css`
- 播放声音 → `core/engine/AudioEngine.ts`
- 乐理换算 → `core/theory/musicTheory.ts`

---

## 三、音频识别流水线（准确度重点）

```
音频文件
  ↓ decode.ts        解码 → 混合单声道 → 降采样 22050Hz（降低运算量）
  ↓ track.ts         逐帧：YIN 基频 + RMS 能量 + 谱通量(onset)
  ↓ track.ts         中值滤波平滑音高轨迹（消除抖动造成的碎音符）
  ↓ segment.ts       分割成离散音符（允许短暂静音间隙、音高跳变断开）
  ↓ tempo.ts         谱通量包络自相关 → BPM（含倍频/半频归一）
  ↓ key.ts           音级时长分布 × Krumhansl 调性轮廓 → 调号
  ↓ analyze.ts       量化时值、分小节、补休止 → 可编辑简谱
```

### 相比原版的关键改进

| 环节 | 原版 | 现版 |
|------|------|------|
| YIN 差分函数 | 朴素 O(N²)，整首歌极慢 | **FFT 自相关 O(N log N)**，快 1~2 个数量级 |
| 采样率 | 原始 44.1kHz 直接算 | 降采样到 22.05kHz + 块平均抗混叠 |
| 音高抖动 | 无处理 | **中值滤波**平滑轨迹 |
| 节拍估计 | 音符间隔直方图（粗糙） | **谱通量包络自相关** + 抛物线插值 + 倍频校正 |
| 调号估计 | 音级时长占比最大者 | **Krumhansl-Schmuckler 调性轮廓相关**（大/小调都判） |
| 时值量化 | 硬编码阈值分段 | **对数距离量化**到标准时值表（含附点） |
| 休止符 | 只在小节补满时插入 | 按音符间隙**自动插入休止** |

### 关于「伴奏 + 人声」的说明

纯浏览器端不做全曲复音分离（Demucs 这类模型体积大、需后端）。当前策略：
- 取单声道混合后做**单音基频跟踪**（YIN），配合中值滤波与置信度阈值，
  对「主旋律突出的音频」（清唱、单音旋律、旋律明显的流行歌）效果最好；
- 若后续要更强的人声分离，可在 `core/audio/` 下新增 `separate.ts` 接入
  后端（如 Demucs / Spleeter）或中置声道消除，流水线接口已经预留。

---

## 四、常用快捷键

| 键 | 功能 |
|----|------|
| 1-7 | 输入 do re mi fa sol la si |
| 0 | 休止符 |
| ↑↓ | 升 / 降八度 |
| ←→ | 移动光标 |
| Q / E | 缩短 / 延长时值 |
| W | 附点 |
| Space | 播放 / 停止 |
| Delete | 删除音符 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做 |

---

## 五、技术栈

React 19 + TypeScript + Vite 8 · Web Audio API · 自实现 FFT / YIN · Canvas 渲染 · LocalStorage 持久化


---

## 六、人声 / 伴奏分离（可选，需后端）

识别前可先把「人声」或「伴奏」单独抽出来，再送去做音高识别，能明显提升准确度。

**启动后端**（纯 Python 标准库，**不需要 pip install**）：
双击 `backend/启动后端.bat`，或命令行 `py backend/server.py`。

**在界面使用**：
打开「🎵 音频识别」→ 勾选「人声 / 伴奏分离」→ 选「保留人声」→ 点「检测」确认后端在线 → 「开始识别」。

**接口**：
- `GET  /health` → 服务状态
- `POST /separate?mode=vocal|accompaniment&method=center` → 返回分离后的 WAV

**方法说明**：
- `center`（默认，零依赖）：中置声道提取 —— 人声通常居中，`(L+R)/2` 保留人声、`(L-R)/2` 去掉人声。
- `demucs`（可选，效果更好）：装好 `pip install demucs` 后可用 AI 分离，需要 PyTorch 与 ffmpeg。

前端会把音频在浏览器里解码成 WAV 再发给后端，所以**后端不需要 ffmpeg**。

---

## 七、启动脚本说明（Windows）

| 文件 | 作用 |
|------|------|
| `启动-开发模式.bat` | 装依赖 → `npm run dev` → 自动开浏览器（改代码即时生效） |
| `构建-绿色版.bat` | 构建生产版本到 `dist/` |
| `启动星谱识音.bat` | 起本地静态服务并打开浏览器（没构建会先自动构建） |
| `backend/启动后端.bat` | 启动人声/伴奏分离后端 |

> 脚本用 **GBK 编码**保存（cmd 默认代码页），并用 `goto` 替代 `if(...)` 括号块，
> 避免中文字节里的 `)` 破坏括号结构。如需重新生成：`py scripts/make_bats.py`。

---

## 八、界面里的「横线」是什么

- **识别结果面板的画布**：蓝色柱状 = 波形（音量包络）；**红色折线 = 音高轨迹**（旋律随时间的高低，音高平稳时看着就像一条横线）。
- **生成的简谱**：音符下方的**横线是减时线**（八分音符 1 条、十六分音符 2 条），表示时值更短，属正常记谱。
