# PITFALLS.md — 实战坑清单

每一条都真实踩过。出问题时先按编号查。

## §1 摄像机/坐标映射（最容易错，错过两次）

`#world` 是 1920×1080 的 div，`transform-origin` 默认是**元素中心 (960,540)**。变换：
`transform: translate(960-cx px, 540-cy px) scale(s)`。

**正确映射**（p 为 world 坐标，O=(960,540)，T=(960−cx, 540−cy)）：

```
screen = O + s·(p − O) + T
screen_x = s·(p_x − 960) + (1920 − cx)
screen_y = s·(p_y − 540) + (1080 − cy)
```

**可视世界范围**（该帧能看到的世界区域）：

```
x ∈ [ 960 − (1920−cx)/s ,  960 + cx/s ]
y ∈ [ 540 − (1080−cy)/s ,  540 + cy/s ]
```

常见错误：把公式写成 `s·(p−cx)`（错的！）。每写一个 CAM 键，把该节要看的 UI 的 world 坐标代进可视范围验算一遍。

## §2 嵌套 absolute 的坐标要累加

`#modal { left:485px }` 若放在 `#main{left:280px}`（又在 `#win{left:180px}`）里，它的 world x = 180+280+485 = **945**，不是 485。所有光标目标点、摄像机对准点、可视范围验算都必须用**累加后的 world 坐标**。教训：曾因漏加 460px 导致弹窗一半被裁、右侧按钮全部不可见。

## §3 overflow:hidden 会无声裁剪

窗口卡片和弹窗通常 `overflow:hidden`（为了圆角）。任何比容器宽的内容（全宽表格、状态徽章在行尾）都会被**无声裁掉**。对策：
- 内容区给 `max-width`（表格 700、宽卡片 ≤720）；
- 或行尾状态改放到行内；
- 冒烟时专门看每一节的**最右侧元素**是否完整。

## §4 CSS translate 会被 JS 内联 transform 覆盖

`.keymodal{ left:50%; transform:translate(-50%,-50%) }` —— 一旦 JS 每帧写 `el.style.transform = 'translate(x,y) scale(s)'`，居中就失效，元素锚着左上角跑到画面外。对策：居中一律用 `left:calc(50% - 宽/2px)`，JS 只管位移/缩放动画。

## §5 字体

- CJK 字体文件大（20MB+）：jsdelivr 单文件有 20MB 上限会返回错误文本；Google Fonts 在部分网络极慢。**方案：npmmirror 拉 `@fontsource/<font>` 的 tgz（一次 86MB 秒下），解包后按 unicode-range 过滤分片**（fetch_fonts.py 已实现）。单连接限速时分片下载会卡死，别并发硬拉。
- CJK 衬线字体只有 Bold：`@font-face` 里注册为 `font-weight:400`，否则浏览器伪加粗发糊。
- 分片 CSS 用 `font-display:block`，且渲染前 `await document.fonts.ready`，否则首批帧回退字体。
- `.disp` 栈写 `'Instrument Serif','Noto Serif SC',serif`：西文走前者、中文回退后者，混排才自然。

## §6 Playwright / 截图

- 全局安装的 playwright `require` 不到：`NODE_PATH="$(npm root -g)"` 必须带。
- 不用自带的 chromium（要下载 150MB），直接 `chromium.launch({executablePath: Edge路径})`。
- `screenshot({type:'jpeg', path:'x.png'})` → **数据是 JPEG、扩展名是 png**，ffmpeg 按扩展名探测解码器会报 `Invalid PNG signature`。要么扩展名与 type 一致，要么输入侧显式 `-f image2 -c:v mjpeg`。
- 每帧流程：`page.evaluate(t => window.__seek(t), t)` → `screenshot`。截图自带同步等待，无需额外延时。
- 页面报错会静默吞掉 `__ready`：render.js 里挂了 `pageerror` 监听，**看到 pageerror 先修 JS 再谈别的**。

## §7 确定性

- 禁止 `Math.random()` 出现在 render 路径：颗粒位移用 `(帧号*53)%240` 这类哈希；随机音效用固定 seed 的 rng。
- 禁止 CSS transition/animation：所有状态每帧由 JS 直接写 inline style。
- `__seek` 要幂等：同一 t 重复调用结果一致（计数器、typed 文本都是纯函数天然满足）。

## §8 构图与碰撞

- 字幕区（screen 110~750px 宽）会压住 UI 左侧——这是风格，但**关键交互目标别放左边**；内容右置靠 cam cx 控制。
- 稠密交互（搜索过滤、弹窗填写）进行时让字幕**提前 1~2s 淡出**，别让衬线大字盖住正在操作的面板。
- 标题/结尾卡容器 `inset:0; flex column; justify-content:center`——漏了 justify 会顶到屏幕上沿裁掉图标。
- 语义色（green/amber/red）浅底 + 深字的组合在两个主题下都要复核对比度。

## §9 音画同步

- 音效事件表以 beat sheet 为准，打字 tick 窗口 = typeInto 的 (t0,t1)；每次 CLICKS 一个 click 音；转场一个 whoosh；成功 ding、失败 buzz 别省。
- 成功/失败音效别同时叠在 whoosh 上，错 0.15s。
- 混音后跑 `loudnorm=I=-17:TP=-1.5`，垫乐压到 -26dB 左右只做氛围。
