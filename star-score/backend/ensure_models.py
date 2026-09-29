# -*- coding: utf-8 -*-
"""启动自检: 确保后端就绪 + GAME 模型已下载（没有则自动下载 small 版）。

由「一键启动.bat」在启动后端后调用:
  py backend\\ensure_models.py

返回码: 0=模型就绪  1=失败(不阻塞前端启动, 可在界面「模型管理」重试)
"""

import json
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:9874'


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)


def main():
    # 1. 等后端起来（最多 10 秒）
    for _ in range(10):
        try:
            get_json(BASE + '/health')
            break
        except Exception:
            time.sleep(1)

    # 2. 查模型状态
    try:
        models = get_json(BASE + '/api/models/list')['models']
    except Exception as exc:
        print('无法连接后端:', exc)
        return 1

    game = next((m for m in models if m['id'] == 'game'), None)
    if game and game.get('installed'):
        print('GAME 模型已就绪（%s）' % (game.get('size') or 'small'))
        return 0

    print('未检测到 GAME 模型，开始自动下载 small 版（约 45MB，用 GPU/CPU 均可推理）...')
    try:
        req = urllib.request.Request(
            BASE + '/api/models/download',
            data=json.dumps({'modelId': 'game-small'}).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
        )
        urllib.request.urlopen(req, timeout=15)
    except Exception as exc:
        print('触发下载失败:', exc)
        return 1

    # 3. 轮询下载进度（最长 6 分钟）
    for _ in range(120):
        time.sleep(3)
        try:
            st = get_json(BASE + '/api/models/status?modelId=game-small')
        except Exception:
            continue
        status = st.get('status')
        if status == 'done':
            print('GAME 模型下载完成')
            return 0
        if status == 'error':
            print('下载失败:', st.get('message'))
            return 1
        print('  模型下载中 %.1f%% ...' % st.get('progress', 0))
    print('下载超时，可稍后到界面「模型管理」查看或重试')
    return 1


if __name__ == '__main__':
    sys.exit(main())
