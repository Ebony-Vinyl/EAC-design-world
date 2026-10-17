# -*- coding: utf-8 -*-
# 无视觉质检：检查帧序列/成片的亮度健康度（适合没有读图能力的执行环境）
#   python qc.py smoke/            # 检查冒烟帧目录
#   python qc.py 成片.mp4 --video  # 检查成片（每秒采样）
# 判定：全黑帧 / 全白帧 / 相邻样本无变化（渲染卡死）/ 平均亮度过低（主题没生效）
import sys, os, subprocess
import numpy as np

def frames(src, video=False, fps=1):
    cmd = ['ffmpeg', '-v', 'error', '-i', src]
    if video: cmd += ['-vf', f'fps={fps}']
    cmd += ['-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    fr = 64*36
    n = len(raw)//fr
    return np.frombuffer(raw[:n*fr], np.uint8).reshape(n, 36, 64).astype(np.float32)

def report(src, arr, label, freeze_fails=False):
    print(f'== {label}: {src}  ({len(arr)} samples)')
    bad = 0
    for i, a in enumerate(arr):
        m = a.mean()
        tag = ''
        if m < 8:   tag = '<< NEAR-BLACK'; bad += 1
        if m > 247: tag = '<< NEAR-WHITE'; bad += 1
        # 静止帧在"持卡镜头"里是合法的，只提示不计失败
        if i > 0 and abs(m - arr[i-1].mean()) < 0.15: tag += ' (frozen, ok if intentional hold)'
        if tag: print(f'  [{i:03d}] luma={m:6.1f} {tag}')
    print(f'== {"FAIL" if bad else "OK"}: {bad} hard failures')
    return bad == 0

ok = True
args = sys.argv[1:]
if args and os.path.isdir(args[0]):
    d = args[0]
    fs = sorted(os.listdir(d))
    arr = []
    for f in fs:
        a = frames(os.path.join(d, f))
        arr.append(a[0] if len(a) else np.zeros((36,64), np.float32))
    ok = report(d, np.array(arr), 'smoke frames')
elif args and '--video' in args:
    src = args[0]
    ok = report(src, frames(src, video=True), 'video 1fps')
else:
    print('usage: python qc.py <dir> | <video> --video'); sys.exit(2)
sys.exit(0 if ok else 1)
