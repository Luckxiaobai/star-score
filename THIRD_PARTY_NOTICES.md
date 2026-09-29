# 第三方组件与版权声明（THIRD-PARTY NOTICES）

本项目（星谱识音 StarScore）的源代码以 MIT License 发布（见 [LICENSE](LICENSE)）。
但项目同时使用了以下第三方开源组件与预训练模型权重。请保留以下版权与许可声明。

---

## 一、总览

| 组件 | 用途 | 协议 | 版权归属 |
|---|---|---|---|
| React / React DOM | 前端 UI 框架 | MIT | Meta Platforms, Inc. |
| Vite | 前端构建工具 | MIT | Vite / Ramplex contributors |
| TypeScript | 类型系统 | Apache-2.0 | Microsoft Corporation |
| oxlint | 代码检查 | MIT | oxc contributors |
| @spotify/basic-pitch | 音高检测（WASM/JS） | Apache-2.0 | Spotify AB |
| numpy | 数值计算（后端） | BSD-3-Clause | NumPy developers |
| onnxruntime | ONNX 模型推理（后端） | MIT | Microsoft Corporation |
| scipy | 信号处理（后端可选） | BSD-3-Clause | SciPy developers |
| openvpi/GAME（ONNX 模型权重） | 歌声→音符转写模型 | MIT | openvpi contributors |

> 以上组件均为宽松型协议（MIT / Apache-2.0 / BSD），不构成 copyleft（无 GPL 传染性）。

---

## 二、模型权重声明

### openvpi/GAME（`backend/models/game/`）

本项目随仓库分发的 `encoder.onnx` / `segmenter.onnx` / `estimator.onnx` / `dur2bd.onnx` / `bd2dur.onnx` / `config.json`
来自 [openvpi/GAME](https://github.com/openvpi/GAME) 官方 Release 的 ONNX 发布包。

- 原项目协议：**MIT License**
- 变量契约参考：<https://github.com/openvpi/GAME/blob/main/ONNX.md>
- 本项目 `backend/game_onnx.py` 中的推理调度与解码代码为作者自行实现，未复制上游 PyTorch/Lightning 代码。

> **使用须知（上游免责声明）**：未经本人同意，禁止使用本项目功能去生成任何特定个人（包括政府官员、公众人物）的歌声或语音。

### @spotify/basic-pitch 内置模型（`public/models/basic-pitch/`）

随 `@spotify/basic-pitch` npm 包分发的 WASM 音高模型，协议 **Apache-2.0**，版权归 Spotify AB。

---

## 三、各组件许可全文

### React（MIT）

```
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### openvpi/GAME（MIT）

```
MIT License

Copyright (c) 2025 openvpi contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### @spotify/basic-pitch（Apache-2.0）

```
Copyright 2024 Spotify AB

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### numpy / scipy（BSD-3-Clause）

```
Copyright (c) 2005-2024, NumPy/SciPy developers.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### onnxruntime（MIT）

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### TypeScript（Apache-2.0）

TypeScript is released under the Apache License 2.0. Full text:
<https://github.com/microsoft/TypeScript/blob/main/LICENSE>

### Vite / oxlint（MIT）

MIT License, Copyright (c) Vite contributors / oxc contributors.
Full text available at <https://github.com/vitejs/vite> and <https://github.com/oxc-project/oxc>.
