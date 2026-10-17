# TIMELINE.md — 时间轴、节奏与字幕调度

## 1. 节拍网格

```js
const B0=0.116, BEAT=0.65, BAR=2.6;          // 92.3077 BPM
// 切点 = B0 + 0.65k，k 为整数
const CUTS=[0, 4.016, 6.616, 13.766, 19.616, 24.816, 30.016, 33.916, 39.116, 43.016, 46.916, 55.366, 63.166];
window.__CUTS=CUTS;                            // 音频侧读同一份
```

自作曲路线：切点直接取网格值，**画面时间 = 音乐时间**，不需要任何映射。
**不要**把切点设成"大概 4.2 秒"再事后对拍——差 0.2s 就能听出来。

## 2. 分节节奏规则（用户验收："别太快，展示要有呼吸"）

- 每段 **3.9~8.5s**；全片 8 个内容段以内（宁砍勿塞）。
- 段内结构：进场 0.4s → 1~3 个交互（每个含 0.5s 接近 + 0.3s 按压 + **≥1.2s 结果停留**）→ 收尾。
- 交互要**清脆**（光标 outQuint 前 58% 到位、点击环 0.34s），**展示要慢**（结果状态停留、镜头缓动窗 0.62×段长）。
- 一段只讲一件事；同屏 pop 的卡片错峰 0.09~0.13s。

## 3. 字幕左右交替 + 镜头让位（"界面一直漂移"的来源）

**规则**：相邻分节字幕方向交替（L→R→L→R…），镜头把关键内容推到字幕**反方向**，每次切点镜头都反向平移一次 → 画面持续游移。

```css
.cap { position:absolute; left:110px; width:780px; z-index:40 }
.cap.r{ left:auto; right:110px; display:flex; flex-direction:column; align-items:flex-end; text-align:right }
#scrim{ /* 左字幕：90deg 左深右透明；右字幕段整块 scaleX(-1) 镜像 */ }
```

```js
const RCAP={capI:1, cap2:1, cap4:1, capL:1};   // 右侧字幕段
scrim.style.transform = scrimFlip ? 'scaleX(-1)' : 'none';
```

**镜头让位算法**（以 1920 画布为例）：
- 字幕在**左**（覆盖 screen 110~890）→ 内容中心放 **screen ≈1250~1350** → `cx = 1920 + s·(wx_content−960) − 1300`。
- 字幕在**右**（覆盖 screen 1030~1810）→ 内容中心放 **screen ≈600~700** → `cx = 1920 + s·(wx_content−960) − 650`。
- 宽内容（路由链 700px 世界宽）用小 s + 大 cx 整体左移，别指望只挪一半。

**验收红线**：关键文本（对话回复、终端输出、降级链状态、数字）绝不能被字幕压住；装饰性内容（水缸、卡片边角）被压可接受。

## 4. 大标语卡（参考片构图）

**窗口不退场**：切点处镜头右推（内容偏左）、世界压暗 0.58×，大卡从右侧滑入压在窗口右半。

```css
.bigcard{ position:absolute; left:1022px; top:150px; width:830px; z-index:48;
  background:linear-gradient(165deg,#131a30,#0f1526 55%,#0d1220); /* 不透明 */
  border:1px solid rgba(90,110,190,.32); border-radius:30px }
```

```js
/* 压暗 */ world.style.filter = blur + `brightness(${c.br*(1-0.42*cardDim(t))})`;
/* 滑入 */ T(card,{ o:…, s:mix(.965,1,ki), x:mix(96,0,ki), y:mix(14,0,ki) });  // outBack
/* 进度条 */ bars.forEach(b=>b.style.width=(parseFloat(b.dataset.w)*kb)+'%');   // 1.3s outCubic
```

卡片内容模板（复刻参考片）：mono 眉题 `04 · TOKEN SAVER` → 48px 大标 → 每行 [标签 + 右侧渐变大数字(−67.4%) + 渐变进度条 + 底行 mono 小字] ×2 → 内框 mono 说明 + 右下角小标签（`ops_saver`）→ 脚注。
**卡片时段左侧要保留真实内容**（前一段的面板别急着淡出）：`panelState(t,'agg',S3-0.02,S4-0.12)` 撑过卡片时段。

## 5. 片头/片尾卡

- 片头：窗口失焦（b:12 br:0.80）+ 居中 logo（圆角 30px、蓝辉光 box-shadow）+ 渐变大字 + tagline + mono 脚注；各元素错峰 0.25s 弹入。
- 片尾：同构 + 关键词逐拍弹入（`t0=56.016+0.65i`，与钟琴音同步）+ CTA 胶囊 + 脚注。
- 淡出：`fade.style.opacity = seg(t,T_OUT,DUR,E.inOut)*0.96`。

## 6. WARP 路线（用户指定现成歌曲时才用）

内部时间轴独立设计（切点随手写），加一张单调递增映射表把内部时间吸附到歌的节拍网格：

```js
const WARP=[[内部,成片],…];  window.__WARP=WARP;
function warpT(t){ /* 成片→内部，按 WARP 对线性插值 */ }
/* render 首行：const rt=t; t=warpT(t); */
/* camDrift 用真实时间 rt 取光标；音频侧 audio.py 读同一张 WARP 做逆映射 */
```

音频侧所有事件时间 = `invwarp(内部事件时间)`。改歌换拍子只改 WARP 表 + CUTS，画面代码零改动。
**代价**：多一层间接、易错（warpT 方向写反过）。能用自作曲路线就别用。
