# -*- coding: utf-8 -*-
# 配乐 + 音效合成（纯 numpy，无依赖音频库）
# 用法：python audio.py [时长秒，默认读 film.html 的 __DUR，否则 12]
# 输出：audio_bed.wav  →  再跑 loudnorm 归一（RUNBOOK §6）
#
# ★ 使用前必改两处：
#   1) CHORDS —— 换成贴合影片情绪的 4 个和弦
#   2) EVENTS —— 逐条对齐到 beat sheet 的时刻（参考 reference/audio-our-free-model.py 的密度）
import sys, re, wave
import numpy as np

DUR = 12.0
try:
    html = open('film.html', encoding='utf-8').read()
    m = re.search(r'__DUR=([\d.]+)', html)
    if m: DUR = float(m.group(1))
except Exception:
    pass
if len(sys.argv) > 1: DUR = float(sys.argv[1])

SR = 48000
N = int(SR * DUR)
rng = np.random.default_rng(7)
mix = np.zeros((N, 2))

def add(buf, sig, t0, gain=1.0, pan=0.0):
    i0 = int(t0 * SR)
    if i0 < 0 or i0 >= N: return
    seg = sig[:N - i0]
    buf[i0:i0+len(seg), 0] += seg * gain * min(1, 1-pan)
    buf[i0:i0+len(seg), 1] += seg * gain * min(1, 1+pan)

def env(n, a, r):
    e = np.ones(n); an = max(1, int(a*SR)); rn = max(1, int(r*SR))
    e[:an] = np.linspace(0, 1, an) ** 1.6
    e[-rn:] *= np.linspace(1, 0, rn) ** 1.3
    return e

# ---------------- 垫乐：4 和弦循环（每 chord_len 秒一换） ----------------
NOTE = {'F2':87.31,'A2':110.0,'C3':130.81,'F3':174.61,'A3':220.0,'C4':261.63,'E4':329.63,
        'D3':146.83,'G3':196.0,'Bb3':233.08,'D4':293.66,'F4':349.23,'Bb2':116.54,
        'E3':164.81,'G4':392.0,'A3b':208.0}
CHORDS = [                                   # ← 换这里
    ['F2','C3','F3','A3','C4','E4'],         # Fmaj7 温暖
    ['A2','E3','A3','C4','E4','G4'],         # Am7
    ['D3','F3','A3','D4','F4'],              # Dm7
    ['Bb2','F3','Bb3','D4','F4'],            # Bbmaj7
]
chord_len = 3.75
for rep in range(int(np.ceil(DUR / (chord_len*len(CHORDS))))):
    for ci, ch in enumerate(CHORDS):
        t0 = (rep*len(CHORDS)+ci) * chord_len
        if t0 >= DUR: break
        n = int(chord_len*SR*1.25); t = np.arange(n)/SR
        v = np.zeros(n)
        for k, name in enumerate(ch):
            f = NOTE[name]; det = 1 + 0.0012*np.sin(rep+ci+k)
            v += (np.sin(2*np.pi*f*det*t) + 0.34*np.sin(2*np.pi*2*f*t+0.5)
                  + 0.10*np.sin(2*np.pi*3*f*t+1.1) + 0.22*np.sin(2*np.pi*f*1.003*t+2.0)) / (len(ch)*1.6)
        v *= (1 + 0.10*np.sin(2*np.pi*0.13*t + ci)) * env(n, 1.6, 1.9)
        add(mix, v, t0, gain=0.050, pan=(-0.25 if ci % 2 else 0.25))

# 唱片底噪
crk = (rng.random(N) < 0.00035).astype(float)
crk = np.convolve(crk, np.exp(-np.arange(220)/SR*900), 'same') * rng.random(N)
mix[:, 0] += crk * 0.05; mix[:, 1] += np.roll(crk, 37) * 0.05

# ---------------- 音效合成器 ----------------
def tick(f=2600, d=0.028, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    return (np.sin(2*np.pi*f*t)*np.exp(-t*140) + 0.4*rng.normal(0,1,n)*np.exp(-t*260)) * env(n, 0.001, d*0.8)
def thock(f=170, d=0.11, g=0.16):
    n = int(d*SR); t = np.arange(n)/SR
    return np.sin(2*np.pi*f*(1-1.6*t)*t)*np.exp(-t*26) * env(n, 0.001, d*0.6)
def whoosh(d=0.55, g=0.14, up=True):
    n = int(d*SR); nz = rng.normal(0,1,n)
    alpha = np.linspace(0.985 if up else 0.55, 0.55 if up else 0.985, n)
    out = np.zeros(n); acc = 0.0
    for i in range(n):
        acc = (1-alpha[i])*nz[i] + alpha[i]*acc; out[i] = acc
    out /= (np.abs(out).max()+1e-9)
    return out * np.sin(np.pi*np.arange(n)/SR/d)**1.4
def blip(f=1240, d=0.09, g=0.09):
    n = int(d*SR); t = np.arange(n)/SR
    return (np.sin(2*np.pi*f*t)*np.exp(-t*30) + 0.5*np.sin(2*np.pi*f*1.5*t)*np.exp(-t*44)) * env(n, 0.002, d*0.5)
def ding(fs=(880,1318), d=0.7, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    return sum(np.sin(2*np.pi*f*t)*np.exp(-t*4.2) for f in fs) * env(n, 0.002, d*0.35)
def buzz(d=0.16, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    s = np.sign(np.sin(2*np.pi*112*t))*0.4 + 0.6*rng.normal(0,1,n)*np.exp(-t*22)
    return np.convolve(s, np.ones(6)/6, 'same') * env(n, 0.002, d*0.5)
def riser(d=0.9, g=0.07):
    n = int(d*SR); nz = rng.normal(0,1,n)
    alpha = np.linspace(0.995, 0.5, n); out = np.zeros(n); acc = 0.0
    for i in range(n):
        acc = (1-alpha[i])*nz[i] + alpha[i]*acc; out[i] = acc
    out /= (np.abs(out).max()+1e-9)
    return out * np.linspace(0, 1, n)**1.7
def type_ticks(t0, t1, dt=0.062, g=0.05):
    t, alt = t0, 1
    while t < t1:
        add(mix, tick(2200+alt*420, g=g), t, g, 0.05*alt); t += dt; alt = -alt

# ---------------- ★ 事件表：逐条对齐到你的 beat sheet ----------------
# 模板片时间轴（12s）：打字 0.4-1.2 / 失败 2.3 / 字幕 2.5 / 标题 4.0 / 转场 6.2 /
# 弹窗 6.7 / nav 7.35 / 卡片 7.5+ / 探测 8.75 / 结尾 9.6 / 关键词 10.5+ / 淡出 11.4
type_ticks(0.40, 1.20)
add(mix, buzz(), 2.30, 0.11)
for i, tt in enumerate([2.53, 2.66, 2.79, 3.20]):
    add(mix, thock(150+i*18), tt, 0.13)
add(mix, whoosh(0.6, 0.13), 3.75)
add(mix, thock(90, 0.2, 0.2), 4.15)
for tt in [4.30, 4.55, 4.80]:
    add(mix, tick(1800, g=0.05), tt, 0.05)
add(mix, whoosh(0.5, 0.11), 5.95)
add(mix, tick(1400, g=0.09), 6.55); add(mix, thock(210, g=0.10), 6.75)
add(mix, tick(1400, g=0.09), 7.35)
for i in range(4):
    add(mix, tick(2400+120*i, d=0.02, g=0.035), 7.5+i*0.1)
add(mix, tick(1400, g=0.09), 8.75); add(mix, blip(1560, g=0.06), 8.95)
add(mix, whoosh(0.7, 0.13), 9.35)
add(mix, thock(90, 0.22, 0.2), 9.75)
for i in range(3):
    add(mix, thock(150+i*14, 0.1, 0.1), 10.5+i*0.1)
add(mix, thock(180, 0.12, 0.12), 11.1)
add(mix, ding((880, 1175, 1568), 1.0, 0.08), 11.25)
add(mix, whoosh(1.0, 0.05, up=False), DUR-1.1)

# ---------------- 母带 ----------------
l, r = mix[:, 0], mix[:, 1]
l = np.tanh(l*1.25)/np.tanh(1.25); r = np.tanh(r*1.25)/np.tanh(1.25)
peak = max(np.abs(l).max(), np.abs(r).max())
l *= 0.85/peak; r *= 0.85/peak
pcm = (np.stack([l, r], 1)*32767).astype(np.int16)
with wave.open('audio_bed.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('audio_bed.wav written', DUR, 's')
