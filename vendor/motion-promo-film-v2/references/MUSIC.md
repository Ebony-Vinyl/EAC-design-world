# MUSIC.md — 原创宣传片配乐（纯 numpy 合成）

参考实现：`scripts/audio_composer.py`（可直接改分节表复用）。目标：**吸引注意、调动情绪**——靠"结构"而不是靠音色堆料：紧张→渐强→抽空→爆发→升华。

## 1. 整体架构

```
SR=48000 单文件脚本，读 film.html 的 const CUTS / const CLICKS / const TICKS
混音总线：mix(总线) + busPad/busBass(受 sidechain) + busG(其余音乐) + kickEnv(ducking 用)
铺法：按节拍逐拍循环（kk 从 0 到 DUR/BEAT），每拍查所属分节 → 风格分支铺乐器
```

**分节强度表**（本案例，可直接改）：

```python
SECT=[(0,4.016,['Am'],'tension'),(4.016,6.616,['Am'],'title'),
      (6.616,13.766,['Am','F'],'lite'),(13.766,19.616,['F'],'mid'),
      (19.616,24.816,['C'],'mid'),(24.816,30.016,['G'],'full'),
      (30.016,33.916,['F'],'break'),(33.916,39.116,['Am'],'full2'),
      (39.116,43.016,['C'],'break'),(43.016,46.916,['G'],'build'),
      (46.916,55.366,['Am','F','C','G'],'drop'),
      (55.366,63.166,['Am','F'],'anthem'),(63.166,65.2,['Am'],'out')]
```

风格语义：`tension` 低音脉冲+心跳（最静）→ `title` impact+pad 绽放 → `lite/mid` 轻 groove（底鼓+8分帽+琶音，mid 加拍手）→ `full` 16分帽+贝斯驱动 → `break` **抽掉鼓组只留 pad+sub+钟琴动机**（情绪段落）→ `build` 渐强+军鼓滚奏+riser → `drop` 全奏（和弦逐小节 Am→F→C→G）→ `anthem` 半拍底鼓+大 pad+动机再现（最响）→ `out` 收尾。

**和弦**：A 小调 `Am→F→C→G`（vi-IV-I-V，抒情+推进感）；每小节 2.6s 一换。

## 2. 乐器合成要点（numpy）

| 乐器 | 要点 |
|---|---|
| kick | 正弦扫频 f0→f1（`fr=f1+(f0-f1)·exp(-t·20)`）+ 高频 click 瞬态 + `tanh(v·2.2)` |
| bass | 谐波 1/2/3 叠加 + tanh 饱和，dur≈0.26s，drop 段八度跳 |
| hat | 白噪声一阶差分（高通）+ 短 exp（闭合 9ms / 开镲 55ms） |
| clap | 3 个错峰噪声爆发（0/12/26ms）+ 185Hz 音体 |
| snare | 噪声 τ60ms + 196Hz 音体；build 段做 16 分滚奏渐强 |
| pluck（琶音） | 谐波叠加 + 快衰减（τ0.16s）；lite 用 8 分、其余 16 分，模式 `[0,1,2,3,2,1,3,2]` |
| bell（钟琴/动机） | 泛音 [1, 2.0, 2.92, 4.16]，振幅 [1, .42, .26, .12]——金属感的关键 |
| pad | 每音 3 个失谐正弦（±0.22%）+ 泛音，attack 0.5~1.2s，慢颤音 |
| riser | 噪声循环 + 上升扫频正弦，`^1.8` 包络 |
| impact | 低频 boom（150→34Hz）+ 高通 crash，用于每个关键切点 |

**动机**（记忆点）：8 拍短句 `A4 C5 E5 | D5 C5 D5 E5`（bell 音色），只在 break 和 anthem 出现——**省着用才珍贵**。

## 3. 制作要点

- **sidechain**：kickEnv 归一化后 `busPad *= (1-0.45·env); busBass *= (1-0.30·env)` —— 底鼓一踩，pad/bass 下潜，这是"有推力"的来源。
- **立体声**：其余音乐做 11ms Haas 微延迟展宽（右声道整体后移），pad/bass 居中。
- **关键切点 impact**：`IMPACT_AT=[标题,卡1,降级,卡2,LIVE,结尾]` 满强度 0.5；其余切点轻 impact 0.22 + whoosh + thock。
- **关键词上行音**：结尾 5 个关键词逐拍 `E5 A5 C6 E6 G6` 钟琴（56.016+0.65i），与画面词牌同步。
- **淡入淡出**：0.15s 淡入；结尾 1.75s `(DUR-t)/1.75)^1.2` 淡出。

## 4. 音效层（鼠标交互的"清脆滴答"）

```python
# 点击：双层"滴+哒" —— 高频 tick 叠低频 thock，机械键盘感
for ct in CLICKS: addS(click(3200,0.016),ct,0.20); addS(thock(240,0.05),ct,0.12)
# 光标落点：轻滴答（TICKS 由画面侧 settle 时刻导出）
for st in TICKS: addS(click(3600,0.010),st,0.085)
# 打字窗口 type_ticks(t0,t1)；流式输出用更密的轻 tick
# 结果音效：buzz=失败/限流、ding=成功、blip=数值跳变、chime=复制成功
```

**TICKS 的来源**：画面侧 `settle = t0 + 0.58·(t1−t0)`（光标 outQuint 到位时刻），滤掉光标隐藏时段与贴近 click 的点，写成 `const TICKS=[...]`，音频侧正则读取——音画同源，永不错位。

## 5. 响度与验收

- 母带：`tanh(x·1.25)/tanh(1.25)` → 归一化峰值 0.85 → 成片 ffmpeg `loudnorm=I=-17:TP=-1.5`（实测集成响度 -16~-15.5 LUFS 适合网络投放）。
- **分段 RMS 弧线必查**（用 wave+numpy 分段算）：
  ```
  钩子 0.117 → 安装 0.199 → 卡1 breakdown 0.171(回落) → DROP 0.238 → anthem 0.299(最高) → 淡出
  ```
  breakdown 必须比前后段低、anthem/drop 必须最高——弧线不对就是情绪不对。
- 别忘记：改 film.html 的 CUTS/CLICKS/TICKS 后**必须重跑 audio.py**（它是从 film.html 读时间轴的）。

## 6. 常见错误

- riser/whoosh 噪声循环 `acc` 初始化成 `np.zeros(n)` → `setting an array element with a sequence`，必须标量 `0.0`。
- `DUR` 正则别匹配 `__DUR=DUR`（那是变量名不是数值），用 `DUR=([\d.]+)` 直接匹配 `const FPS=30, DUR=65.0`。
- 大量 pad 叠加会悄悄顶爆总线：pad 单音增益 ≤0.12，靠 sidechain 和 tanh 收。
