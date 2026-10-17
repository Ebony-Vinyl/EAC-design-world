# RUNBOOK.md — 逐步操作手册

从零到成片的完整流程。每步有【输入】【操作】【验收】。全程在一个工作目录进行，如 `D:/视频剪辑/<项目名>/`。

---

## §0 环境自检（一次性）

```bash
node --version            # ≥18
ffmpeg -version | head -1
python --version          # ≥3.10
pip install --quiet fonttools brotli numpy
ls "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"   # Edge 存在
# 全局 playwright（已装则跳过）：npm i -g playwright
# 关键：全局包必须在 NODE_PATH 里才能 require：
NODE_PATH="$(npm root -g)" node -e "require('playwright');console.log('pw ok')"
```

验收：四条全绿。Edge 不存在时改用 Chrome 路径，都没有才 `npx playwright install chromium`。

## §1 拆解参考片与素材（产出：beat sheet）

```bash
mkdir -p ref/frames
ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate 参考片.mp4
ffmpeg -y -v error -i 参考片.mp4 -vf "fps=2,scale=960:540" ref/frames/f_%03d.png   # 每秒2帧
ffmpeg -y -v error -i 参考片.mp4 -vn -ac 1 -ar 22050 ref/audio.wav
ffmpeg -i ref/audio.wav -filter_complex showspectrumpic=s=1280x480 -y ref/spec.png # 看配乐密度
```

用读图能力**逐张查看**（每批 4~6 张），记录：分节结构、字幕版式（眉题/主标/desc/foot 四件套）、转场方式、UI 镜头语言、配色（进 STYLE.md §1.3 取色流程）、节奏（每节几秒）。

然后**读素材片**，列功能清单表格（模块 → 界面元素 → 可演示的动作 → 可展示的数字）。

**产出 beat sheet**（后续一切以此为准，格式如下）：

```markdown
| # | 起~止 | 眉题/标题 | UI 动作（光标点哪、输什么、什么在动） | 字幕四件套 | 音效点 |
|---|-------|-----------|--------------------------------------|------------|--------|
| 钩子 | 0~4.8 | —/六个免费模型，一个一个去试？ | 输入消息→发送→429 失败芯片 | 眉题+主标+错误芯片 | ticks,buzz,pop |
```

验收：用户可读的 beat sheet 定稿（分节数 = 功能数，钩子有具体痛点）。

## §2 主题与素材（产出：fonts/ 就绪）

1. 按 STYLE.md §1 选主题（A/B/从参考片取色），写好 `:root` 备用。
2. 字体：

```bash
python templates/fetch_fonts.py my-film.html
# 脚本行为：西文衬线/等宽从 jsdelivr 拉单文件；CJK 从 npmmirror 拉 @fontsource tarball，
# 解析 unicode-range 只保留用到的分片 → fonts/<family>.css + fonts/<dir>/*.woff2
```

3. 图标：内联 SVG 手绘（圆角方 + 品牌渐变 + 白色字形 + acc 小圆点），不引外部图片。

验收：`fonts/notoserifsc.css` 等文件存在且 <2MB。

## §3 写 film.html（产出：可 seek 的整片）

```bash
cp templates/film-template.html my-film.html      # 基础档
# 或：cp templates/film-template-plus.html my-film.html   # 进阶档（动效更"牛"）
# 进阶档需把 templates/lib/ 一并拷到项目里：cp -r templates/lib .
```

选档参考（详见 SKILL.md「三档动力」）：基础档手写缓动够用且最快；要 onetake 级的弹簧、逐字、冲击、样条光标就用进阶档（`window.OM`，全部纯函数、兼容 `__seek`）。进阶档注意：`#world{transform-origin:0 0}` + `OM.view(cam)` 的 matrix 直接做 transform；`OM.ease.cubicOut`（没有 outCubic）；motion.js 为 PolyForm NC 许可，**商用需授权**。

按 reference/film-our-free-model.html 的成例填充：

1. **替换 `:root`** 为 §2 选定的主题；确认无硬编码色值残留（`grep -E '#[0-9a-fA-F]{6}' my-film.html` 只应命中 :root 与淡出色）。
2. **改窗口/侧栏/顶栏**的品牌信息（logo、菜单名、会话历史——写可信的假数据）。
3. **把 beat sheet 逐行翻译成代码**，每节：
   - 面板 DOM（数据数组 + `build()` 生成，别手写重复卡片）
   - `panelState(t, name, inT, outT)` 注册进 render()
   - CAM 键 1~2 个（drift 用）
   - CPATH 光标点 + CLICKS 点击时刻
   - 字幕组 `capN` 四件套 + caps 数组注册
4. **每个数字动画**用 `fmtCount(seg(...))` 驱动；**打字**用 `typeInto`；**开关**用 `setToggle`。
5. 页面末尾确认：`window.__FPS / __DUR / __seek / __ready` 四件套齐全。

自检（写完立刻做，别等冒烟）：
- 对每个分节键位算可视世界范围（PITFALLS §1 公式），确认该节要看的 UI 坐标在范围内。
- `grep -n 'position:absolute' my-film.html` 逐个检查嵌套偏移是否已累加（PITFALLS §2）。
- `grep -n 'translate(-50%' my-film.html` —— 被 JS 内联 transform 接管的元素不允许依赖它（PITFALLS §4）。

## §4 冒烟测试（最重要的一步）

```bash
NODE_PATH="$(npm root -g)" node templates/render.js --smoke --film my-film.html
# 产出 smoke/s_XX_tT.png（约 29 张，覆盖每个节拍与转场）
```

**逐张查看**，按此清单挑错：
- [ ] 每节字幕四件套完整、无被裁、与 UI 重叠处 scrim 生效
- [ ] 该节的操作目标（按钮/开关/输入框）全部在画面内且光标点击位置对准
- [ ] 数字/表格/徽章右端没有被窗口 `overflow:hidden` 裁掉
- [ ] 标题卡/结尾卡垂直居中、无元素出框
- [ ] 字体是衬线而非回退宋体/雅黑
- [ ] 主题色生效（整片底色正确）

没有读图能力时：`python templates/qc.py smoke/` 做亮度体检（查全黑/全白/无变化帧），并抽 3 帧算主色验证主题。

修复 → 重跑冒烟，直到全过。**这一步不过，禁止全量渲染。**

## §5 全量渲染

```bash
NODE_PATH="$(npm root -g)" node templates/render.js --film my-film.html
# out/f_00000.png 起，帧数 = DUR×FPS；60s ≈ 1800 帧 ≈ 400MB ≈ 4~8 分钟
```

验收：帧数正确、无 pageerror 输出（render.js 会把控制台错误打出来）。

## §6 音轨（产出：audio/bed_norm.wav）

1. 复制 `templates/audio.py` → `audio.py`，把 **EVENTS 事件表逐条对齐到 beat sheet 的时刻**（打字 tick 窗口、每次 click、转场 whoosh、成功 ding、失败 buzz、结尾关键词 pops）。参考 reference/audio-our-free-model.py 的密度：60s 片约 80~110 个事件。
2. 和弦进行改成贴合影片情绪的 4 个和弦（温暖=Fmaj7 系；紧张=Emin 系；科技=sus2 挂留），每 3.75s 一换、循环。
3. 运行：

```bash
python audio.py                                                # → audio_bed.wav
ffmpeg -y -v error -i audio_bed.wav -af "loudnorm=I=-17:TP=-1.5" -ar 48000 audio/bed_norm.wav
```

验收：波形峰值 TP ≤ -1.5dB；事件密度主观合理（无声段不超过 4s）。

## §7 合成

```bash
ffmpeg -y -v error -framerate 30 -f image2 -c:v mjpeg -i out/f_%05d.png -i audio/bed_norm.wav \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k \
  -shortest -movflags +faststart 成片.mp4
```

> `-c:v mjpeg` 必须带：Playwright 截图按 type 编码、按扩展名命名时扩展会骗过 ffmpeg 的探测（PITFALLS §6）。

## §8 成片质检

```bash
mkdir qc && for t in 1.2 3.8 5.9 10.2 12.6 16.2 21.3 26.3 32.3 37.4 41.3 50.9 57.2 59.7; do
  ffmpeg -y -v error -ss $t -i 成片.mp4 -frames:v 1 qc/q_$t.png; done
ffmpeg -i 成片.mp4 -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"
ffprobe -v error -show_entries format=duration -of csv=p=0 成片.mp4   # 必须=DUR
```

逐张查看 qc 帧；`mean_volume` 应在 -25~-18dB、`max_volume` ≤ -0.5dB。发现问题的修复顺序：改 film.html → 只重跑 §5+§7（帧已删则重渲染）；只改音频则只重跑 §6+§7。

## §9 交付

- 成片路径 + 时长/规格
- 分节表（beat sheet 定稿版）
- 源码位置（film.html / audio.py），并说明：改文案/节奏后重跑 §5~§7 即可出新版

## §10 常见需求映射

| 用户要求 | 做法 |
|---|---|
| 换配色 | 换 :root 主题块（STYLE.md §1），其余不动 |
| 加一节功能 | beat sheet 加一行 → 面板 DOM + panelState + CAM + capN + 音效，后续节时间整体平移 |
| 更短的 25s 版 | 砍到 4~5 节、钩子 4s、实测 6s、结尾 5s |
| 用真实桌面录屏当一段素材 | ffmpeg 截取片段 → 作为独立场景层垫在 world 里（object-fit: cover），字幕系统照常叠加 |
| 竖屏 1080×1920 | stage/world 全换竖版尺寸，摄像机可视范围公式同步换 (x:960→540, y:540→960) |
