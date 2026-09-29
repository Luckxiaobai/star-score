"""
core — HumanV 可复用核心库
这是整个工作台的"共享能力层"。它被 human_vocal_workbench 使用，
未来也可以被其他项目 import 复用。
边界规则（详见 core/README.md）：
  - core 只放"多项目都会用到"的能力
  - core 不依赖 tools/、server.py、frontend/
  - core 不引入重依赖（torch / 模型文件等），重功能放 tools/
版本说明：
  __version__ 是"库 API 版本"，独立于：
    - 工程格式版本（vproj_schema.VERSION，管 .vproj 兼容性）
    - 契约文档版本（核心契约 v0.3.2.md，管设计语义）
  三者用途不同，各自演进。
"""
__version__ = "0.1.0"
# 核心能力清单——这就是"什么算核心"的边界宣言。
# 注意：main.py 不在其中——它是服务接入层，不是核心能力。
__all__ = [
    "vproj_schema",           # 数据模型 / 序列化 / 版本校验
    "midi_doc",               # MIDI 解析 / 清洗 / 导出
    "audio_utils",            # 音频读取 / 重采样 / 归一 / 哈希 / 核心段
    "slice_lib",              # 切片库 / 变调变速调度
    "single_sample_binder",   # 单样本循环批量绑定
    "render_engine",          # 整轨渲染
]
