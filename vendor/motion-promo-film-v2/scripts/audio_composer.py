# -*- coding: utf-8 -*-
# 原创宣传片配乐《Free Flight》+ 音效层（纯 numpy 合成，无音频库依赖）
# ------------------------------------------------------------------
# 节拍网格与 film.html 完全一致：92.3077 BPM（0.65s/拍），B0=0.116s，1 小节=2.6s。
# 全部 12 个分节切点都落在节拍上；音乐按同一网格作曲，所以每个切点
# 同时是音乐事件（impact/和弦变换/加花）。
#
# 结构（对齐 film.html 的 CUTS）：
#   0.000 紧张钩子   低音脉冲+心跳+半拍帽, 3.15 起 riser
#   4.016 标题       impact + Am pad 绽放
#   6.616 一键安装   轻快 groove: 底鼓+8分帽+拨弦琶音 (Am→F)
#  13.766 免费模型   +拍手反拍, 16分琶音 (F)
#  19.616 白嫖签到   (C)
#  24.816 聚合渠道   (G) 全编制+16分帽, 28.9 riser
#  30.016 标语卡1    breakdown: 只有 pad+sub+钟琴动机（情绪段落）
#  33.916 路由降级   groove 回来 (Am), 37.2 impact+降级音效
#  39.116 标语卡2    breakdown 2 (C)
#  43.016 本地网关   build: 渐强+军鼓滚奏+riser
#  46.916 实测 LIVE  THE DROP: 全奏 Am→F→C→G 逐小节循环
#  55.366 结尾卡     anthem: 半拍底鼓+大 pad+钟琴动机+关键词上行音
#  63.166 淡出       pad 收尾
import re, json, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)

# ---------------- 读 film.html 时间轴 ----------------
html = open('film.html', encoding='utf-8').read()
DUR   = float(re.search(r'DUR=([\d.]+)', html).group(1))
CUTS  = json.loads(re.search(r'const CUTS=(\[[^\]]*\])', html).group(1))
CLICKS= json.loads(re.search(r'const CLICKS=(\[[^\]]*\])', html).group(1))
TICKS = json.loads(re.search(r'const TICKS=(\[[^\]]*\])', html).group(1))
N = int(SR * DUR)

mix    = np.zeros((N, 2))   # 总线
busPad = np.zeros(N)        # 和弦垫（受 sidechain）
busBass= np.zeros(N)        # 贝斯（受 sidechain）
busG   = np.zeros(N)        # 其余音乐
kickEnv= np.zeros(N)        # 底鼓包络（用于 ducking）

def add(buf, sig, t0, gain=1.0):
    i0 = int(t0 * SR)
    if i0 < 0 or i0 >= N: return
    seg = sig[:N - i0]
    buf[i0:i0+len(seg)] += seg * gain

def addS(sig, t0, gain=1.0):
    add(mix[:,0], sig, t0, gain); add(mix[:,1], sig, t0, gain)

# ---------------- 乐器 ----------------
def envx(n, a=0.004, r=0.1):
    e = np.ones(n); an=max(1,int(a*SR)); rn=max(1,int(r*SR))
    e[:an] = np.linspace(0,1,an)**2
    e[-rn:] *= np.linspace(1,0,rn)**1.5
    return e

def kick(f0=118, f1=42, dur=0.32):
    n=int(dur*SR); t=np.arange(n)/SR
    fr=f1+(f0-f1)*np.exp(-t*20)
    v=np.sin(2*np.pi*np.cumsum(fr)/SR)*np.exp(-t*14)
    v+=0.25*rng.normal(0,1,n)*np.exp(-t*320)
    return np.tanh(v*2.2)*0.8

def sub(f, dur=1.6):
    n=int(dur*SR); t=np.arange(n)/SR
    return np.sin(2*np.pi*f*t)*envx(n,0.02,dur*0.5)

def bass(f, dur=0.28, bright=0.5):
    n=int(dur*SR); t=np.arange(n)/SR
    v=np.sin(2*np.pi*f*t)
    v+=bright*0.45*np.sin(2*np.pi*2*f*t)+bright*0.2*np.sin(2*np.pi*3*f*t)
    v=np.tanh(v*1.8)*0.75
    return v*envx(n,0.004,dur*0.35)

def hat(open_=False):
    dur=0.09 if open_ else 0.028
    n=int(dur*SR); nz=rng.normal(0,1,n)
    nz=np.diff(nz,prepend=0)
    return nz/np.abs(nz).max()*np.exp(-np.arange(n)/SR/(0.055 if open_ else 0.009))

def clap():
    n=int(0.2*SR); v=np.zeros(n)
    for d,g in [(0,1),(0.012,0.8),(0.026,0.6)]:
        i=int(d*SR); m=n-i
        v[i:]+=rng.normal(0,1,m)*np.exp(-np.arange(m)/SR/0.03)*g
    v+=0.4*np.sin(2*np.pi*185*np.arange(n)/SR)*np.exp(-np.arange(n)/SR/0.05)
    return v/np.abs(v).max()

def snare(g=1.0):
    n=int(0.16*SR)
    v=rng.normal(0,1,n)*np.exp(-np.arange(n)/SR/0.06)
    v+=0.5*np.sin(2*np.pi*196*np.arange(n)/SR)*np.exp(-np.arange(n)/SR/0.04)
    return v*g

def pluck(f, dur=0.55):
    n=int(dur*SR); t=np.arange(n)/SR
    v=np.sin(2*np.pi*f*t)+0.55*np.sin(2*np.pi*2*f*t)*np.exp(-t*14)+0.22*np.sin(2*np.pi*3*f*t)*np.exp(-t*22)
    return v*np.exp(-t/0.16)*envx(n,0.002,0.05)

def bell(f, dur=1.5):
    n=int(dur*SR); t=np.arange(n)/SR
    v=np.zeros(n)
    for m,a in [(1,1),(2.0,.42),(2.92,.26),(4.16,.12)]:
        v+=a*np.sin(2*np.pi*f*m*t)*np.exp(-t/(dur*0.35/m**0.5))
    return v*envx(n,0.002,0.1)

def padTone(f, dur, a=0.9, r=0.9):
    n=int(dur*SR); t=np.arange(n)/SR
    v=np.sin(2*np.pi*f*t)+0.5*np.sin(2*np.pi*f*1.0022*t+0.7)+0.5*np.sin(2*np.pi*f*0.9978*t+1.9)
    v+=0.28*np.sin(2*np.pi*2*f*t+0.4)+0.12*np.sin(2*np.pi*3*f*t)
    e=np.ones(n); an=max(1,int(a*SR)); rn=max(1,int(r*SR))
    e[:an]=np.linspace(0,1,an)**1.5
    e[-rn:]*=np.linspace(1,0,rn)**1.2
    return v/2.3*e*(1+0.08*np.sin(2*np.pi*0.16*t))

def riser(dur=1.2):
    n=int(dur*SR); nz=rng.normal(0,1,n)
    acc=0.0; out=np.empty(n)
    for i in range(n):
        al=0.965-0.25*(i/n)**2
        acc=(1-al)*nz[i]+al*acc; out[i]=acc
    out/=np.abs(out).max()+1e-9
    t=np.arange(n)/SR
    sweep=np.sin(2*np.pi*np.cumsum(np.linspace(240,980,n))/SR)*0.25
    return out*np.linspace(0,1,n)**1.8 + sweep*np.linspace(0,1,n)**2.2

def impact():
    n=int(1.4*SR); t=np.arange(n)/SR
    fr=34+(150-34)*np.exp(-t*10)
    boom=np.sin(2*np.pi*np.cumsum(fr)/SR)*np.exp(-t*4.5)
    crash=rng.normal(0,1,n)*np.exp(-t/0.35)
    crash=np.diff(crash,prepend=0)
    return boom*0.9+crash/np.abs(crash).max()*0.4

# ---------------- 音名/和弦 ----------------
NF={'A1':55.0,'C2':65.41,'D2':73.42,'E2':82.41,'F2':87.31,'G2':98.0,'A2':110.0,
    'C3':130.81,'D3':146.83,'E3':164.81,'F3':174.61,'G3':196.0,'A3':220.0,'B3':246.94,
    'C4':261.63,'D4':293.66,'E4':329.63,'G4':392.0,'A4':440.0,'B4':493.88,
    'C5':523.25,'D5':587.33,'E5':659.26,'G5':783.99,'A5':880.0,
    'C6':1046.5,'D6':1174.66,'E6':1318.51,'G6':1567.98}
CH={'Am':['A2','E3','A3','C4','E4'],
    'F' :['F2','C3','F3','A3','C4'],
    'C' :['C3','G3','C4','E4','G4'],
    'G' :['G2','D3','G3','B3','D4']}
ROOT ={'Am':'A1','F':'F2','C':'C2','G':'G2'}
FIFTH={'Am':'E2','F':'C3','C':'G2','G':'D3'}

B0, BEAT, BAR = 0.116, 0.65, 2.6
ARP=[0,1,2,3,2,1,3,2]   # 琶音顺序（和弦音索引）

# 动机（A 小调，2 小节 / 8 拍）：深情上扬的落点句
MOTIF=[(0.0,'A4',1.7),(1.0,'C5',1.7),(2.0,'E5',2.4),(4.0,'D5',1.7),
       (5.0,'C5',1.7),(6.0,'D5',1.4),(7.0,'E5',2.2)]
def playMotif(t0,g=1.0):
    for off,nm,d in MOTIF:
        add(busG,bell(NF[nm],d),t0+off*BEAT,0.16*g)

# ---------------- 分节结构 ----------------
SECT=[(0.0,4.016,['Am'],'tension'),(4.016,6.616,['Am'],'title'),
      (6.616,13.766,['Am','F'],'lite'),(13.766,19.616,['F'],'mid'),
      (19.616,24.816,['C'],'mid'),(24.816,30.016,['G'],'full'),
      (30.016,33.916,['F'],'break'),(33.916,39.116,['Am'],'full2'),
      (39.116,43.016,['C'],'break'),(43.016,46.916,['G'],'build'),
      (46.916,55.366,['Am','F','C','G'],'drop'),
      (55.366,63.166,['Am','F'],'anthem'),(63.166,65.2,['Am'],'out')]
def sect_at(t):
    for s in SECT:
        if s[0]<=t<s[1]: return s
    return SECT[-1]

# ---------------- 按节拍铺音乐 ----------------
nb=int(np.ceil((DUR-B0)/BEAT))
for kk in range(nb):
    t=B0+kk*BEAT
    if t>=DUR: break
    sec=sect_at(t)
    ch=sec[2][int((t-sec[0])//BAR)%len(sec[2])]
    style=sec[3]
    notes=CH[ch]; inBar=kk%4
    prog=(t-sec[0])/(sec[1]-sec[0])

    # ---- 无鼓段落 ----
    if style=='tension':
        k=kick(105,42,0.30); add(busG,k,t,0.30); add(kickEnv,np.exp(-np.arange(len(k))/SR/0.09),t,0.45)
        add(busBass,bass(NF['A1'],0.26,0.25),t,0.42)
        add(busG,hat(),t+BEAT/2,0.14)
        if inBar==0: add(busBass,sub(NF['A1'],1.3),t,0.10)
        for n in notes: add(busPad,padTone(NF[n],BAR*1.06,0.6,0.55),t,0.035)
        continue
    if style=='title':
        for n in notes: add(busPad,padTone(NF[n],BAR*1.6,1.2,1.0),t,0.085)
        if inBar==0:
            add(busG,pluck(NF['A4']),t,0.12); add(busG,pluck(NF['E5']),t+BEAT*1.5,0.10)
        continue
    if style=='break':
        if inBar==0:
            for n in notes: add(busPad,padTone(NF[n],BAR*1.35,0.8,0.9),t,0.11)
            add(busBass,sub(NF[ROOT[ch]],2.3),t,0.30)
            playMotif(t,1.0)
        continue
    if style=='out':
        for n in notes: add(busPad,padTone(NF[n],BAR*1.4,1.0,1.2),t,0.07)
        if inBar==0: add(busG,bell(NF['A5'],2.0),t,0.06)
        continue

    # ---- 有鼓段落 ----
    g=0.85+0.3*prog if style=='build' else 1.0
    # 底鼓
    if style=='anthem':
        if inBar in (0,2):
            k=kick(125,40,0.4); add(busG,k,t,0.42); add(kickEnv,np.exp(-np.arange(len(k))/SR/0.1),t,0.6)
    elif style=='build':
        k=kick(118,42,0.32); add(busG,k,t,0.30*g); add(kickEnv,np.exp(-np.arange(len(k))/SR/0.09),t,0.5*g)
    else:
        k=kick(118,42,0.32); add(busG,k,t,0.36); add(kickEnv,np.exp(-np.arange(len(k))/SR/0.09),t,0.55)
    # 反拍拍手
    if style in ('mid','full','full2','drop') and inBar%2==1:
        add(busG,clap(),t,0.16)
    # build：小节尾军鼓 + 45.7 起滚奏推 drop
    if style=='build' and inBar==3:
        for j in range(4): add(busG,snare(0.5+0.4*j),t+j*BEAT/4,0.08)
    if style=='build' and t>=45.7:
        for j in range(4):
            gg=0.05+0.10*(t-45.7)/1.2
            add(busG,snare(1.0),t+j*BEAT/4,gg)
    # 帽
    if style in ('full','full2','drop'):
        add(busG,hat(),t+BEAT/4,0.10); add(busG,hat(),t+BEAT/2,0.12)
        add(busG,hat(),t+3*BEAT/4,0.10)
        if inBar==3: add(busG,hat(True),t+BEAT/2,0.12)
    else:
        add(busG,hat(),t+BEAT/2,0.13)
    # 贝斯
    rt=NF[ROOT[ch]]; ft=NF[FIFTH[ch]]
    if style=='anthem':
        if inBar==0: add(busBass,bass(rt,1.2,0.4),t,0.34)
        if inBar==2: add(busBass,bass(ft,1.2,0.4),t,0.26)
    elif style in ('full','full2','drop'):
        for j in range(2):
            f=rt*(2 if (j==1 and inBar%2==1) else 1)
            add(busBass,bass(f,0.26,0.7),t+j*BEAT/2,0.30)
    else:
        for j in range(2):
            add(busBass,bass(rt,0.24,0.45),t+j*BEAT/2,0.22)
    # 琶音
    if style=='lite':
        for j,ai in enumerate(ARP[:4]):
            add(busG,pluck(NF[notes[ai%len(notes)]],0.4),t+j*BEAT/2,0.085)
    else:
        bright=1.0 if style=='drop' else 0.8
        for j in range(8):
            ai=ARP[j%len(ARP)]
            gg=0.075*bright*(1.15 if j%4==0 else 1.0)
            add(busG,pluck(NF[notes[ai%len(notes)]],0.34),t+j*BEAT/4,gg)
    # 和弦垫
    pg={'lite':0.06,'mid':0.07,'full':0.08,'full2':0.08,'build':0.085,'drop':0.095,'anthem':0.12}.get(style,0.06)
    for n in notes:
        add(busPad,padTone(NF[n],BAR*1.06,0.5,0.5),t,pg)
    # drop 小节头高音拨奏
    if style=='drop' and inBar==0:
        for n2 in notes[1:4]:
            add(busG,pluck(NF[n2]*2,0.5),t,0.09)
    # anthem 动机
    if style=='anthem' and inBar==0:
        playMotif(t,0.9)

# ---------------- 一次性事件（音乐层） ----------------
IMPACT_AT=[4.016,30.016,37.2,39.116,46.916,55.366]
for c in IMPACT_AT:
    addS(impact(),c,0.5)
for c in CUTS[1:]:
    if c in IMPACT_AT: continue
    addS(impact(),c,0.22)
add(busG,riser(0.85),3.15,0.16)
add(busG,riser(1.1),28.9,0.16)
add(busG,riser(1.25),45.65,0.2)
add(busG,riser(0.8),54.55,0.14)
# 关键词上行钟琴（56.016 起逐拍，落在节拍上）
for i,nm in enumerate(['E5','A5','C6','E6','G6']):
    addS(bell(NF[nm],1.6),56.016+i*BEAT,0.17)
# LIVE 段高音点缀（52.116 C 和弦小节头）
addS(bell(NF['G5'],1.2),52.116,0.10)

# ---------------- 音效层 ----------------
def tick(f=2600,d=0.028):
    n=int(d*SR); t=np.arange(n)/SR
    return (np.sin(2*np.pi*f*t)*np.exp(-t*140)+0.4*rng.normal(0,1,n)*np.exp(-t*260))*envx(n,0.001,d*0.8)
def thock(f=170,d=0.11):
    n=int(d*SR); t=np.arange(n)/SR
    return np.sin(2*np.pi*f*(1-1.6*t)*t)*np.exp(-t*26)*envx(n,0.001,d*0.6)
def whoosh(d=0.55):
    n=int(d*SR); nz=rng.normal(0,1,n)
    acc=0.0; out=np.empty(n)
    for i in range(n):
        al=0.985-0.43*(i/n); acc=(1-al)*nz[i]+al*acc; out[i]=acc
    out/=np.abs(out).max()+1e-9
    return out*np.sin(np.pi*np.arange(n)/SR/d)**1.4
def blip(f=1240,d=0.09):
    n=int(d*SR); t=np.arange(n)/SR
    return (np.sin(2*np.pi*f*t)*np.exp(-t*30)+0.5*np.sin(2*np.pi*f*1.5*t)*np.exp(-t*44))*envx(n,0.002,d*0.5)
def ding(fs=(880,1318),d=0.7):
    n=int(d*SR); t=np.arange(n)/SR
    return sum(np.sin(2*np.pi*f*t)*np.exp(-t*4.2) for f in fs)*envx(n,0.002,d*0.35)
def buzz(d=0.16):
    n=int(d*SR); t=np.arange(n)/SR
    s=np.sign(np.sin(2*np.pi*112*t))*0.4+0.6*rng.normal(0,1,n)*np.exp(-t*22)
    return np.convolve(s,np.ones(6)/6,'same')*envx(n,0.002,d*0.5)
def click(f=3200,d=0.016):
    n=int(d*SR); t=np.arange(n)/SR
    v=np.sin(2*np.pi*f*t)*np.exp(-t*200)+0.55*rng.normal(0,1,n)*np.exp(-t*500)
    return v*envx(n,0.001,d*0.7)
def type_ticks(t0,t1,dt=0.062,g=0.045):
    t,alt=t0,1
    while t<t1:
        addS(tick(2200+alt*420),t,g); t+=dt; alt=-alt

# 每个交互点：清脆"滴+哒"双层点击声
for ct in CLICKS:
    addS(click(3200,0.016),ct,0.20); addS(thock(240,0.05),ct,0.12)
# 光标每次落位：轻滴答（交互质感）
for st in TICKS: addS(click(3600,0.010),st,0.085)
# 打字/流式 ticks
type_ticks(0.55,1.5); type_ticks(8.55,9.6)
type_ticks(26.0,26.6); type_ticks(28.05,28.5)
type_ticks(48.6,49.05); type_ticks(52.85,53.3)
type_ticks(49.95,51.0,0.05,0.03); type_ticks(54.0,55.15,0.05,0.03)
type_ticks(10.1,11.3,0.12,0.035)
# 切点 whoosh + 底鼓点（impact 已在音乐层）
for c in CUTS[1:]:
    addS(whoosh(0.6),c-0.22,0.12); addS(thock(95,0.16),c,0.12)
# 结果音效
addS(buzz(),2.85,0.12)                    # 429 限流
addS(ding(),11.65,0.10)                   # 插件装好
addS(blip(1560),22.6,0.07); addS(blip(1760),22.95,0.07)   # +100 积分/翻牌
addS(ding(),29.3,0.09)                    # 聚合已保存
addS(buzz(),37.25,0.10)                   # 路由 429
addS(blip(1400),37.65,0.07); addS(ding((880,1175,1568),0.8),38.1,0.09)  # 降级→接管
addS(ding((988,1480)),45.05,0.08)         # 已复制

# ---------------- 合成总线 ----------------
kn=kickEnv.max()
if kn>0: kickEnv/=kn
busPad  *= (1-0.45*kickEnv)     # pad 侧链下潜
busBass *= (1-0.30*kickEnv)     # bass 轻下潜
d=int(0.011*SR)
gR=np.concatenate([np.zeros(d),busG[:-d]])   # Haas 微延迟展宽
mix[:,0]+=busG*0.95 + busPad + busBass*0.5
mix[:,1]+=gR*0.95   + busPad + busBass*0.5
# 全局淡入淡出
tt=np.arange(N)/SR
fade=np.ones(N)
ni=int(0.15*SR); fade[:ni]=np.linspace(0,1,ni)
fade*=np.clip((DUR-0.05-tt)/1.75,0,1)**1.2
mix*=fade[:,None]
# 母带
l=np.tanh(mix[:,0]*1.25)/np.tanh(1.25); r=np.tanh(mix[:,1]*1.25)/np.tanh(1.25)
peak=max(np.abs(l).max(),np.abs(r).max())
l*=0.85/peak; r*=0.85/peak
pcm=(np.stack([l,r],1)*32767).astype(np.int16)
with wave.open('audio_bed.wav','wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(f'audio_bed.wav written: {DUR}s 原创配乐 Free Flight @92.3BPM | cuts={len(CUTS)} clicks={len(CLICKS)} ticks={len(TICKS)}')
