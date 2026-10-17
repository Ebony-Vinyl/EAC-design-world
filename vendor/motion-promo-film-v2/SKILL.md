---
name: motion-promo-film-v2
description: 制作「参考片风格」产品宣传片：悬浮居中窗口舞台、UI 实机交互演示、左右交替大字幕、大标语卡、原创配乐卡点、逐帧确定性渲染合成 MP4。当用户要求做产品宣传片/演示片/插件介绍片（约 30~90s），说"学习这种视频剪辑""完美复刻这支片""给某插件/App 做个介绍视频"，或给了参考视频/歌曲/截图要求同风格成片时使用。覆盖：参考片拆解 → 节拍网格时间轴 → 确定性 HTML 动画 → 锚点光标系统 → 原创配乐合成 → ffmpeg 合成 → 视觉验收全流程。（motion-promo-film 的完整升级版：新增悬浮窗口舞台、零偏移光标、字幕左右交替、原创配乐四大能力；无头浏览器逐帧渲染 + 纯 numpy 作曲，无外部素材依赖。）
---

# motion-promo-film-v2 — 参考片风格产品宣传片

**产出形态**：约 65s、1920×1080@30fps、深色舞台 + 悬浮居中应用窗口 + 左右交替大字幕 + 光标实机交互 + 大标语卡 + 片头/片尾卡 + 原创配乐，合成单个 MP4。

**两条路线，先选路线再动手**：
- **A. 用户给了现成歌曲要卡点** → 用「WARP 时间扭曲」架构：内部时间轴独立设计，WARP 表把切点吸附到歌曲节拍网格，画面代码不动（详见 references/TIMELINE.md 末节）。
- **B. 自作曲（推荐，默认）** → 直接把全部切点设计在节拍网格上，音乐按同一网格作曲，切点天然是音乐事件，**不需要 WARP**。

## 六条核心架构决策

1. **确定性动画**：全部画面是一个 HTML 文件里的纯函数 `window.__seek(t)`。禁止 CSS transition/animation、禁止 `Math.random()` 出现在渲染路径（用 `(帧号*53)%240` 这类哈希做颗粒抖动）。同一 t 重复渲染结果必须一致。
2. **三层坐标**：`#stage`(1920×1080 屏幕层，放字幕/卡片/淡入淡出) → `#world`(摄像机层，JS 每帧写 transform) → `#win`(悬浮窗口层，JS 每帧写"反向漂移 + 基准缩放")。**光标放在 stage 层**，用解析公式算屏幕坐标（见决策 4）。
3. **节拍网格**：`B0=0.116, BEAT=0.65`（92.3 BPM），小节 `BAR=2.6`。**所有分节切点 = B0 + 0.65k**（写死在 `const CUTS`）。每段 3.9~8.5s，段内每次操作结果停留 ≥1.2s——交互要清脆（outQuint 前 58% 甩到位），但展示要有呼吸。
4. **锚点光标（零偏移的关键）**：所有点击/镜头目标用 `ANCHOR_SEL` 选择器在启动时（`fonts.ready` 之后、首次 render 之前）用 `getBoundingClientRect` 实测世界坐标；光标画在 stage 层，屏幕坐标 = 锚点 + 窗口漂移 → 过摄像机矩阵。**绝不手填坐标**。三个致命坑与公式见 references/CURSOR-ANCHOR.md。
5. **字幕左右交替**：相邻分节字幕左右交替出现，镜头反向让位（字幕在右→内容偏左），scrim 暗幕镜像翻转。这是"界面一直漂移"感的来源，也避免字幕压住关键内容。规则见 references/TIMELINE.md。
6. **原创配乐**：纯 numpy 合成，分节强度表驱动（紧张→渐强→breakdown→drop→anthem），kick sidechain 下潜 pad/bass，关键词落在节拍上。结构模板见 references/MUSIC.md，参考实现 scripts/audio_composer.py。

## 流水线（每阶段一个 gate，不通过不进下一阶段）

### Phase 0 · 拆解参考片
抽帧采样（ffmpeg 抽 8~16 帧）、取色（深色主题：#05080f 舞台 / #141519 窗口 / #5b79ff 蓝 / #9fb0f0 淡紫）、量出节奏（分节时长、切点间隔）、记下标志性构件（大字幕四件套=眉题/主标/描述/脚注、光标点击环、大标语卡、片头尾卡）。若用户给了歌：numpy 频谱通量做 onset、自相关求 BPM（本案例 92.3 BPM / 0.65s 拍）。

### Phase 1 · 时间轴设计（beat sheet）
先写 BEATS.md 再写代码：分节表（#/起止/眉题标题/UI 动作/音乐），切点全部落在节拍网格。**先算总账**：钩子 4s + 标题卡 2.6s + 8 个内容节 + 实测 8.5s + 结尾 7.8s + 淡出 1.8s ≈ 65s。宁可砍分节（10 段砍到 8 段）也不要每段塞两个交互。字幕左右方向在表里就定好。

### Phase 2 · film.html
单文件：fonts(@font-face 本地 woff2) → CSS(tokens/窗口/面板/字幕/标语卡/光标) → DOM(窗口+全部面板+对话框+卡片+字幕+光标) → JS(helpers/时间轴常量/锚点/摄像机/光标路径/render 分节脚本/boot)。
- 摄像机：`CAM` 键支持 `{a:'锚点',dx,dy}` 启动时解析成绝对坐标；缓动窗 `0.62×段长`。
- 窗口：`translate(±13px 反向漂移) scale(0.93)`，基准缩放必须在 measureAnchors 前写入。
- boot：`fonts.ready → measureAnchors() → resolveCam() → resolveCpath() → render(0/1/10) → __ready=true`。
细节与公式见 references/STAGE-WINDOW.md、CURSOR-ANCHOR.md。

### Phase 3 · 渲染前双 gate（必做，省一次全量渲染）
1. `node render.js --smoke`（29 帧）→ 逐张看构图/遮挡/字体/光标。
2. `node probe.js` → 光标落点 17 点全部 |delta|≤3px。
两个 gate 都过才全量 `node render.js --film film.html`（1950 帧，约 5~8 分钟，可后台跑）。

### Phase 4 · 配乐 + 音效
`python audio.py`（参考 scripts/audio_composer.py）：读 film.html 里的 `const CUTS/CLICKS/TICKS`，按分节表铺音乐 + 音效层。必查：分段 RMS 弧线（钩子最低→anthem 最高）、clicks 双层"滴+哒"、光标落点轻滴答。细节见 references/MUSIC.md。

### Phase 5 · 合成
```bash
ffmpeg -y -framerate 30 -f image2 -c:v mjpeg -i out/f_%05d.jpg -i audio_bed.wav \
  -filter:a loudnorm=I=-17:TP=-1.5 -ar 48000 -c:v libx264 -crf 17 -preset medium \
  -pix_fmt yuv420p -movflags +faststart -shortest "成片.mp4"
```

### Phase 6 · 验收
- 从**成片**抽 12~16 个关键帧（含每个分节切点后 0.5~1s）逐张检查：光标落点、字幕遮挡、卡片干净、logo 不变形。
- `ffprobe` 查时长；`ebur128` 查响度（-17 目标，宣传片 -16~-15 可接受）。
- 有 visual-judge 可用则派发一次（只派一次，别自查+派发双跑）；不可用则亲自逐帧看。

### Phase 7 · 交付与清理
删 out/ smoke/ qc/ 中间帧与 wav（MP4 + film.html + audio.py + BEATS.md + 字体 + logo 保留）。BEATS.md 与成片一起留档。

## 关键公式速查

```
世界→屏幕：  screen = (960-cx) + 960 + s·(wx-960)      // #world origin=(960,540)
窗口漂移：    wdx = -clamp(camDriftX,-40,40)·0.32       // 反向轻漂，与摄像机视差成对
光标屏幕坐标：px = 锚点x + wdx;  sx = (960-cx)+960+s·(px-960)   // 锚点已含基准缩放
光标路径：   k = outQuint(clamp((t-t0)/(span·0.58),0,1))  // 前 58% 甩到位，余下停住
落点时刻：   settle = t0 + 0.58·(t1-t0)                  // 供音频落点滴答
节拍网格：   t_k = 0.116 + 0.65k                          // 所有 CUTS 从这里取
```

## 常见坑 Top 10（完整版见 references/PIPELINE.md）

1. 锚点重复缩放：锚点已是"基准缩放后"的世界坐标，光标公式里**不要再乘 0.93**。
2. transform-origin：`#world` 默认 origin=(960,540)，世界→屏幕映射有 `+960/+540` 原点项，漏掉必偏。
3. 父级 scale 会让子元素 `translate(-50%,-50%)` 也缩放 → 光标缩放放子元素上，别放父级。
4. 帧扩展名：`screenshot({type:'jpeg', path:'x.png'})` 数据是 JPEG 扩展名是 png，ffmpeg 报 `Invalid PNG signature`——扩展名与 type 一致，或输入侧 `-f image2 -c:v mjpeg`。
5. 全局 playwright：`NODE_PATH="$(npm root -g)"` 必须带。
6. 分节切换后旧面板要显式 `opacity:0`，不然会在新分节里"还魂"。
7. 卡片滑入时段让窗口**压暗保留**（brightness 0.58）而不是退场——参考片构图，左侧保留真实内容。
8. 中文歌名/路径 Unicode 在 Git Bash 下 `cp` 会报 Illegal byte sequence → 用 Python `shutil.copyfile`。
9. 音频 riser/whoosh 的噪声循环里 `acc` 必须初始化为标量 0.0，写成 `np.zeros(n)` 会 `setting an array element with a sequence`。
10. 渲染前先 `render(0);render(1);render(10)` 预热，否则首批帧可能字体未就绪。

## 参考文件索引

- `references/STAGE-WINDOW.md` — 悬浮窗口舞台：几何、装饰、窗口漂移、摄像机模型与键位表。
- `references/CURSOR-ANCHOR.md` — 锚点光标系统：测量、屏幕映射、三大坑、落点滴答、探针用法。
- `references/TIMELINE.md` — 时间轴：节拍网格、分节节奏规则、字幕左右交替与镜头让位、标语卡构图、WARP 路线。
- `references/MUSIC.md` — 原创配乐：分节强度表、乐器合成、sidechain、响度弧线、音效层。
- `references/PIPELINE.md` — 命令速查、渲染/合成坑、验收协议、清理。
- `scripts/render.js` — 逐帧抓帧（Playwright + Edge headless）。
- `scripts/probe.js` — 光标锚点精确度探针（17 点验证）。
- `scripts/audio_composer.py` — 配乐合成参考实现（分节表 + 音效层）。
- `scripts/fetch_fonts.py` — 字体获取（西文 jsdelivr + CJK npmmirror tarball 按 unicode-range 过滤）。
- `references/example-film.html` + `references/example-BEATS.md` — **完整实战范例**（65s 成品全代码 + 分节表，改内容时以此为准抄结构）。
