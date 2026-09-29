# core — HumanV 可复用核心库

## 这是什么

`core/` 是整个工作台的**共享能力层**。它被 `human_vocal_workbench` 使用，
未来也可以被其他项目（扒谱工具、混音工具等）import 复用。

## 边界规则

每次想往 core 加东西时，问一句：

> **"这是核心能力（多项目都会用），还是本项目功能（只有它用）？"**

- **核心能力** → 放 `core/`
- **本项目功能** → 放 `tools/`（插件）或项目自己的目录
- **新项目** → 独立目录，`import core` 复用

## 什么该放 core

- 数据模型与序列化（如 `vproj_schema`）
- 音频基础操作（读取/重采样/归一/哈希）
- 通用引擎（MIDI 处理、形变、渲染）
- **多项目都会用到**的算法

## 什么不该放 core

- ❌ **服务接入层**（`server.py`、`main.py`）——那是"本项目"的
- ❌ **具体功能插件**（源分离、降噪、变声）——放 `tools/`
- ❌ **前端代码**——放 `frontend/`
- ❌ **UI 相关逻辑**——core 不知道任何 UI 的存在
- ❌ **重依赖功能**（需要 torch / 模型文件的）——放 `tools/` 的独立进程

## 依赖规则

**核心一条：`core/` 不依赖 `tools/`、`server.py`、`frontend/`。**

依赖方向是单向的：

```
frontend/ ─┐
tools/    ─┼─→ core/     （core 谁都不依赖）
server.py ─┘
```

core 可以被整体复制到另一个项目，只改 `import` 就能用。

## 当前模块

| 模块 | 职责 |
|---|---|
| `vproj_schema.py` | 数据模型 / 序列化 / 版本校验 / 会话 |
| `midi_doc.py` | MIDI 解析 / 清洗 / 导出 |
| `audio_utils.py` | 音频读取 / 重采样 / 归一 / 哈希 / 核心段检测 |
| `slice_lib.py` | 切片库 / 变调变速调度（pyrubberband 优先 + scipy 降级） |
| `single_sample_binder.py` | 单样本循环批量绑定 |
| `render_engine.py` | 整轨渲染 |

**不含** `main.py`（服务接入层，属本项目）。

## 运行方式

各模块自带自检，直接运行即可：

```
cd human_vocal_workbench
py core\vproj_schema.py
py core\midi_doc.py
py core\audio_utils.py
py core\slice_lib.py
py core\single_sample_binder.py
py core\render_engine.py
```

## 已知技术债

**import 机制尚未包化。** 当前每个模块内部用 `sys.path` 注入来导入同目录模块：

```python
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from vproj_schema import (...)
```

这是为了支持"直接 `py core\xxx.py` 跑自检"。代价是：`core` 作为包被外部 import 时，
子模块之间的相对导入不是标准包写法。

**不急于修**。触发包化重构的条件是：**当 core 第一次需要被另一个独立项目 import 时**。
届时会把上述写法改为标准包导入（`from .vproj_schema import ...` 或
`from core.vproj_schema import ...`），并把运行方式统一为 `python -m core.xxx`。
在此之前，保持现状——它已验证可用，不值得为了"形式正确"而返工。
