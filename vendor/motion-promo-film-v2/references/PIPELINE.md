# PIPELINE.md — 命令速查、渲染坑与验收协议

## 1. 完整命令序列（工作目录 = 影片工程目录）

```bash
# 0) 字体（一次性）：npmmirror 拉 @fontsource tarball，按 unicode-range 过滤
python fetch_fonts.py film.html

# 1) 冒烟 29 帧（改完 film.html 的第一道 gate）
NODE_PATH="$(npm root -g)" node render.js --smoke

# 2) 光标锚点探针（第二道 gate，17 点 |delta|≤3px）
NODE_PATH="$(npm root -g)" node probe.js

# 3) 全量渲染 1950 帧（约 5~8 分钟，可后台）
NODE_PATH="$(npm root -g)" node render.js --film film.html

# 4) 原创配乐 + 音效（读 film.html 的 CUTS/CLICKS/TICKS）
python audio.py

# 5) 合成
ffmpeg -y -framerate 30 -f image2 -c:v mjpeg -i out/f_%05d.jpg -i audio_bed.wav \
  -filter:a loudnorm=I=-17:TP=-1.5 -ar 48000 -c:v libx264 -crf 17 -preset medium \
  -pix_fmt yuv420p -movflags +faststart -shortest "成片.mp4"

# 6) 验收：抽关键帧 + 查响度
ffmpeg -ss 31.4 -i 成片.mp4 -frames:v 1 -y qc/q_31.4.png     # 每个分节切点 +0.5~1s 各抽一张
ffprobe -v error -show_entries format=duration -of csv=p=0 成片.mp4
ffmpeg -i 成片.mp4 -af ebur128 -f null - 2>&1 | grep -A8 Summary
```

## 2. 环境与渲染坑

- **Playwright**：全局安装，必须 `NODE_PATH="$(npm root -g)"`；用本机 Edge 免下载：`chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'})`。
- **帧格式**：`screenshot({type:'jpeg', path:'out/f_00000.jpg'})` —— 扩展名必须与 type 一致；ffmpeg 输入用 `-f image2 -c:v mjpeg -i out/f_%05d.jpg` 兜底。
- **pageerror 监听必挂**：页面 JS 报错会静默吞掉 `__ready`，渲染脚本里 `p.on('pageerror',...)` 打到 stdout，先修 JS 再谈别的。
- **`window.__ready`**：`fonts.ready → measureAnchors → resolveCam/resolveCpath → render 预热 → __ready=true`；render.js 用 `waitForFunction('window.__ready===true')`。
- **确定性**：渲染路径禁 `Math.random()`（用 `(帧号*53)%240` 哈希）、禁 CSS transition/animation；`__seek` 幂等。
- **Unicode 文件名**（中文歌名/路径）在 Git Bash `cp` 报 `Illegal byte sequence` → 用 Python `shutil.copyfile`。
- **CJK 字体**：jsdelivr 单文件 20MB 上限、Google Fonts 慢；用 npmmirror tarball + unicode-range 过滤（fetch_fonts.py）。分片 CSS `font-display:block`，渲染前 `await document.fonts.ready`。
- **性能**：1950 帧单进程顺序截屏即可；每 150 帧打点日志。渲染期间不要动 film.html。

## 3. 常见布局坑

- `overflow:hidden` 会无声裁剪比容器宽的内容（全宽表格、行尾徽章）——冒烟时专门看每节**最右侧元素**是否完整。
- 嵌套 absolute 坐标要累加：`#modal{left:25}` 在 `#main{left:280}`（又在 `#win{left:180}`）里，world x = 180+280+25（再乘窗口基准缩放）。所有镜头对位都用**锚点**，不手算。
- 分节切换：上一节的面板必须显式 `T(el,{o:0})`，不然会残留。
- 字幕与 UI 冲突：见 TIMELINE.md 第 3 节的红线（关键文本不可被压）。
- 语义色（绿/琥珀/红）在深底上复核对比度；`--greenSoft` 类浅底深字组合要单独看。

## 4. 验收协议（视觉 gate）

1. **两道渲染前 gate**（smoke + probe）必须先过——省掉一次全量重渲。
2. 从**最终 MP4**（不是帧目录）抽 12~16 帧：每个分节切点后 0.5~1s、片头/片尾、每个标语卡。逐张检查：
   - 光标是否精准落在目标上（对照 probe 结果）；
   - 字幕是否遮挡关键内容；
   - 卡片场景是否干净（无半透明鬼影/残影）；
   - logo 是否圆角无拉伸；文字无裁剪溢出。
3. **视觉验收只跑一次**：有 visual-judge 类代理则派发一次（给 PNG 路径清单+每帧预期内容），不可用则亲自逐帧看——**禁止自查+派发双跑**。
4. 响度：ebur128 集成响度 -17±1.5 LUFS，LRA 参考 3~6。
5. 时长：ffprobe 对齐设计值（本案例 65.000s）。

## 5. 交付与清理

保留：成片 MP4、film.html（唯一画面源）、audio.py（唯一音频源）、BEATS.md（分节表）、fonts/、logo/素材。
删除：`out/ smoke/ qc/`、`audio_bed.wav`、临时探针输出、旧的渲染日志。
交付说明里给出：成片路径、关键规格（时长/分辨率/响度）、"改哪里重跑哪三条命令"。
