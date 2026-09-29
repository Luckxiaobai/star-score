# -*- coding: utf-8 -*-
"""星谱识音 StarScore —— 一键启动(替代所有 .bat 脚本)

职责:
  1. 检查 Node.js / Python
  2. 补齐后端依赖 (demucs + music21)
  3. 补齐前端依赖与构建 (首次)
  4. 启动后端 (端口 9874, 已运行则跳过)
  5. 模型自检 + 自动下载 (GAME)
  6. 启动前端 (端口 4173, 自动打开浏览器)

用法:
  py backend/start_all.py
  或由根目录「一键启动.bat」调用。

说明:
  本文件用 UTF-8 保存; Python 输出中文到控制台走宽字符 API,
  无论系统代码页是 936 还是 65001 都能正常显示, 不会乱码。
"""

import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根目录
BACKEND_DIR = os.path.join(ROOT, 'backend')


# ---------------------------------------------------------------- 小工具

def step(text):
    print()
    print('=' * 52)
    print('  ' + text)
    print('=' * 52)


def ok(text):
    print('  [OK] ' + text)


def warn(text):
    print('  [警告] ' + text)


def fail(text):
    print('  [错误] ' + text)


def find_python():
    """优先 py 启动器, 其次 python; 都没有返回 None。"""
    for cand in ('py', 'python'):
        if shutil.which(cand):
            return cand
    return None


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_port(port, timeout=45):
    """最多等 timeout 秒, 端口可连即返回 True。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.5)
    return False


def run(cmd, cwd=None):
    """执行子命令。Windows 上 npm 实际是 npm.cmd, 直接 CreateProcess 找不到, 需补后缀。"""
    cmd = list(cmd)
    if os.name == 'nt' and cmd and cmd[0] == 'npm':
        cmd[0] = 'npm.cmd'
    print('  > ' + ' '.join(cmd))
    return subprocess.run(cmd, cwd=cwd).returncode


# ---------------------------------------------------------------- 主流程

def main():
    print()
    print('  ============================================')
    print('    星谱识音 StarScore - 一键启动')
    print('    识别链路: Demucs 分离 + GAME 转录 + music21 后处理')
    print('  ============================================')

    # ---- 1. Node.js ----
    if shutil.which('node') is None:
        fail('未检测到 Node.js, 正在打开官网下载页面...')
        import webbrowser
        webbrowser.open('https://nodejs.org/')
        input('安装完成后重新运行本脚本。按回车退出...')
        return 1
    ok('Node.js')

    # ---- 2. Python ----
    py = find_python()
    if py is None:
        fail('未检测到 Python, 正在打开官网下载页面...')
        import webbrowser
        webbrowser.open('https://www.python.org/downloads/')
        input('安装时请勾选 "Add Python to PATH"。按回车退出...')
        return 1
    ok('Python (%s)' % py)

    # ---- 3. 后端依赖 ----
    step('检查后端依赖 (demucs + music21 + numpy/scipy 合成引擎)')
    r = run([py, '-c', 'import demucs, music21, numpy, scipy'], cwd=ROOT)
    if r != 0:
        warn('缺少后端依赖, 正在安装(首次约 1-2 分钟)...')
        if run([py, '-m', 'pip', 'install', 'demucs', 'music21', 'numpy', 'scipy'], cwd=ROOT) != 0:
            warn('依赖安装失败, 后端识别功能不可用, 前端编辑器仍可运行')
        else:
            ok('后端依赖安装完成')
    else:
        ok('后端依赖已就绪')

    # ---- 4. 前端依赖 + 构建 ----
    step('检查前端')
    if not os.path.isdir(os.path.join(ROOT, 'node_modules')):
        ok('正在安装前端依赖 (npm install)...')
        run(['npm', 'install'], cwd=ROOT)
    if not os.path.isfile(os.path.join(ROOT, 'dist', 'index.html')):
        ok('正在构建前端 (npm run build)...')
        run(['npm', 'run', 'build'], cwd=ROOT)

    # ---- 5. 启动后端 ----
    step('启动后端 (端口 9874)')
    backend = None
    if port_open(9874):
        ok('后端已在运行')
    else:
        backend = subprocess.Popen(
            [py, 'server.py', '--port', '9874'], cwd=BACKEND_DIR)
        if wait_port(9874):
            ok('后端已启动')
        else:
            warn('后端启动超时, 请稍后手动检查')

    # ---- 6. GAME 模型自检 + 自动下载 ----
    if backend is not None:
        step('检查 GAME 模型')
        run([py, os.path.join('backend', 'ensure_models.py')], cwd=ROOT)

    # ---- 7. 启动前端 + 自动开浏览器 ----
    step('启动前端 (端口 4173, 自动打开浏览器)')
    if port_open(4173):
        ok('前端已在运行')
    else:
        run(['node', os.path.join('scripts', 'serve.mjs')], cwd=ROOT)

    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        print('已退出')
