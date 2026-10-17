# STYLE.md — 风格 DNA

这套风格的本质：**「真实软件界面实机演示」+「编辑排版级的动态字幕」+「镜头推拉」**。界面是可信的（有真实的层级、文案、数字），字幕是杂志感的（衬线大标题 + 等宽眉题），镜头是克制的（每节一个慢推，切点才动）。

配色是**主题**，不是定式。代码里只允许 `var(--xxx)`。§1 给出两套内置主题 + 从任意参考片取色的流程。

---

## §1 主题系统（只改 :root，别动其他代码）

变量清单（film.html 必须全部引用这些名字）：

```css
--paper   页面底色          --card    卡片/窗口表面     --card2   次级表面(侧栏/顶栏)
--ink     主文字            --ink2    次文字            --mut     弱文字/占位
--line    分隔线            --line2   描边
--blue    品牌主色(交互)     --blueSoft 品牌浅底         --blueLine 品牌描边
--acc     影片强调色(字幕/重点) --accSoft 强调浅底
--green   成功              --greenSoft   --amber 降级/警告  --amberSoft
--red     失败/危险         --redSoft     --navy 深色块
--shadow  大阴影            --shadowSm 小阴影
```

### 1.1 Theme A「奶油纸感」（onetake 风格，浅色产品 UI 适用）

```css
:root{
  --paper:#f2ecdf; --card:#faf6ec; --card2:#f3edde;
  --ink:#28221a; --ink2:#57503f; --mut:#8d8171;
  --line:#e3d8c2; --line2:#d3c5a9;
  --blue:#4d6bfe; --blueSoft:#e7ecff; --blueLine:#c9d4ff;
  --acc:#d4552f; --accSoft:#f6e3d8;
  --green:#5c8a57; --greenSoft:#e2ecda;
  --amber:#bd8636; --amberSoft:#f3e7cd;
  --red:#bb4a2c; --redSoft:#f5dfd4; --navy:#253352;
  --shadow:0 42px 90px rgba(88,62,26,.17),0 14px 30px rgba(88,62,26,.10);
  --shadowSm:0 10px 26px rgba(88,62,26,.10),0 2px 8px rgba(88,62,26,.07);
}
```
舞台底色加两层极淡的径向渐变（左上提亮、右下压暗）+ 4% 噪点颗粒 + 边缘暗角。

### 1.2 Theme B「深色科技」（dsh-ops 风格，深色产品 UI 适用）

```css
:root{
  --paper:#0a0d16; --card:#11141f; --card2:#171b28;
  --ink:#f2f4f8; --ink2:#c7cbd6; --mut:#78808f;
  --line:#232837; --line2:#2d3346;
  --blue:#5b79ff; --blueSoft:#1a2140; --blueLine:#2c3a6e;
  --acc:#e86a3d; --accSoft:#3a241c;
  --green:#4fae6e; --greenSoft:#15291c;
  --amber:#d99a3d; --amberSoft:#33270f;
  --red:#e05a3a; --redSoft:#371a12; --navy:#151d33;
  --shadow:0 42px 90px rgba(0,0,0,.5),0 14px 30px rgba(0,0,0,.35);
  --shadowSm:0 10px 26px rgba(0,0,0,.35);
}
```
Theme B 里 grain 不透明度降到 0.035，vignette 加深到 0.22，字幕仍用衬线（浅色墨）。

### 1.3 Theme R「从参考视频取色」

用户给了参考片但不属于 A/B 时，按此流程生成主题（RUNBOOK §2 有命令）：

1. 用 ffmpeg 从参考片均匀抽 40~60 帧（避开纯转场帧）。
2. 用 `palettegen` / 简单 k-means 取 8~12 个主色，人工归类到变量槽位：
   - **底色** ← 出现面积最大的低饱和色（占比 >50%）
   - **卡片色** ← 比 底色 亮/暗半档的第二大面积色
   - **ink** ← 文字像素的中位色（取直方图两端）
   - **acc** ← 高饱和点缀色（面积 1~10%，取饱和度最高的簇）
   - **green/amber/red** ← 语义色，可从参考片 UI 状态元素取，取不到就用 §1.1 的语义色并微调色相贴近主题
3. 校验对比度：ink 对 paper ≥ 7:1，ink2 ≥ 4.5:1，mut ≥ 2.5:1（仅装饰）；acc 上的文字用 paper。
4. 主题写入 `:root` 后，抽 3 帧冒烟确认「底/卡/字幕」三层分离清晰。

---

## §2 字体系统

| 角色 | 字体 | 用法 |
|---|---|---|
| 西文展示衬线 | Instrument Serif 400（含 italic） | 片名词牌、大标题里的西文、数字点睛；italic 只做点缀词 |
| 中文展示衬线 | Noto Serif SC 700（注册为 400 用） | 大标题、desc、tagline |
| 等宽 | JetBrains Mono 400/700 | 眉题、代码、数字、表格、脚注 |
| UI 黑体 | Segoe UI / Microsoft YaHei | 界面内的中文与正文（系统字体，不用下载） |

- 大标题栈：`font-family:'Instrument Serif','Noto Serif SC',serif` —— 西文自动走 Instrument，中文回退 Noto Serif，一行内混排天然和谐。
- 字号：分节大标题 88px（一句 ≤ 10 个字，两行内）；desc 27px/1.6；眉题 16.5px/字距 .2em；UI 内正文 12.5~15px；表格等宽 12.5px。
- 字体获取用 `templates/fetch_fonts.py`（国内镜像，CJK 按 unicode-range 只下用到的分片，~800KB）。CSS 里 CJK 衬线注册成 `font-weight:400` 避免伪加粗。

## §3 动效字幕系统（影片的招牌）

每节一组，左侧 110px、宽 640px，结构四件套：

```
— 01 · ZERO SETUP            ← 眉题：mono 700 16.5px，字距 .2em，acc 色，前置 "— "
免登录，免 Key                ← 主标题：display 88px，ink 色，一句话
打开即用的模型清单             ← desc：display 27px，ink2，≤2 行
——  上下文 · 限速，一目了然    ← foot：mono 15.5px mut，前置 34px 短横线(acc)
```

- 入场：**blur-in**（opacity 0→1，y +34→0，blur 13→0，0.55s outExpo），四件套依次错 0.13s。
- 出场：0.28s 反向 blur-out，在下一节开始前 0.2s 完成。
- 字幕后面垫 **scrim**：从左侧 paper 色 97% 渐变到 56% 处透明，让字幕永远可读（字幕允许压在 UI 上，这正是参考片的构图）。
- 辅助件：错误芯片（`subchip`：mono 700 19px，红点 + `429 · Too Many Requests`，红浅底胶囊）——开场痛点的固定道具。
- 字幕**允许与 UI 重叠**（衬线大字压在界面上是风格的一部分），但关键数字/按钮不要被盖。

## §4 UI 复刻规范

- 主体是一个「应用窗口」卡片：圆角 24px，`--card` 底，1px 高光描边 + 双层软阴影；内含标题条、侧栏（`--card2`）、主区。窗口外永远是 paper 底。
- 内部再嵌「设置弹窗」做分节舞台：圆角 20px、大阴影，自带左侧导航。**分节镜头推到弹窗内容区**（cam cx≈1110, cy≈700, s≈1.5，见 §5）。
- 组件风格：胶囊 chip（1px line2 描边、圆角 999/12）、卡片（圆角 14、shadowSm、内边距 16）、toggle（44×25，on 用品牌蓝）、表格（等宽字、行高 44、head 行 mut 色）、徽章 tag（ok 绿/no 红/强调 acc 浅底）。
- 数字一律等宽字体。状态用「彩点 + 文字」不用纯色块。
- 品牌蓝只出现在**可交互元素**（主按钮、激活态、开关、链接）；影片强调橙只出现在**字幕与点睛数字**。两者不混用。
- 菜单/标签/文案必须像真的：控件名用行业通用词，数字要有来源感（"3/13 已接入"、"51 ms"、"0.2.3 → 0.2.4"），但**不使用真实用户的隐私数据**。

## §5 运动系统

缓动表（全部自己实现，禁止 CSS 缓动）：

| 名字 | 公式 | 用途 |
|---|---|---|
| outExpo | `1-2^(-10t)` | 一切位移/淡入的默认 |
| outBack(1.9) | 过冲回弹 | 卡片/弹窗/徽章 pop（0.5s，scale .7~.92→1） |
| inOut | 三次 | 摄像机、光标移动 |
| outCubic | `1-(1-t)^3` | 计数器、进度 |

- **摄像机**：world 1920×1080，`transform: translate(960-cx, 540-cy) scale(s)`，origin 中心。映射式：`screen = s·(p−960/540) + (1920−cx / 1080−cy)`；可视范围 `x∈[960−(1920−cx)/s, 960+cx/s]`。键位表 CAM=[{t,x,y,s,b,br}...]，键间过渡 0.55s inOut。
  - 钩子段：全景慢推（s 1.00→1.05）
  - 标题/结尾：s≈0.9 + blur 13px + brightness 0.8（背景失焦）
  - 分节：s 1.48~1.53，cy≈700~715，cx 让内容右置（左侧留给字幕）
- **转场三件套**：切点前 UI 亮度 0.9 略压 → whoosh 音效 → 新面板 0.3s outCubic 淡入 + y 16→0。
- **pop**：卡片网格逐个 0.07~0.13s 错峰 outBack；徽章出现时叠一圈 box-shadow 光环淡出。
- **打字**：等速逐字 + 光标 2.8Hz 闪烁，结束后光标留 1.4s 再消失。
- **计数器**：0.9~1.1s outCubic，等宽字，单位后缀跟随。
- **光标**：圆点 15px + 点击扩散环，放 world 层内，`scale(1/cam.s)` 保持屏幕尺寸恒定；移动 inOut，CLICKS 表驱动脉冲。
- **颗粒**：SVG feTurbulence 平铺，opacity .05（深色主题 .035），背景位移用 `帧序号` 哈希 —— 保持确定性。

## §6 叙事模板（分节结构）

```
钩子 0~5s      真实 UI 里一个具体的痛点瞬间（打字→失败芯片→报错），字幕抛出问题
标题卡 2.5s     图标落位 + 词牌(衬线) + 一句 tagline + 「社区插件 · 非官方」
01..0N 每节4~6s  眉题编号 + 大标题 + desc + foot；UI 内完成一次可看见的操作(点击/输入/开关/计数)
实测 8~10s      回到聊天界面，真实打两轮对话，展示模型真实回复（速度可加快进）
结尾卡 6~7s     图标 + 词牌 + tagline + 4~5 个关键词列(竖线分隔) + CTA 路径胶囊 + 脚注 + 淡出至暗
```

- 分节标题公式：**动宾短语，口语化，≤8 字**（"一键安装" / "签到，自动领取" / "先预览，再动手"）。眉题 = `— 0N · 英文标签`。
- 每节必须有一次**人手操作**（光标点击/输入/拖动），纯展示的节没有说服力。
- 数字要"有出处"：footer 注明「本机实测 / 非基准测试 / 数据不出本机」这类限定语。
- 开场痛点的错误芯片（429/401/ParserError）与第一节的解法要形成对答。
- 结尾关键词 = 全片分节标题各压缩成 2~3 字。

## §7 标题卡 / 结尾卡

- 图标：圆角方 28px 渐变底 + 白色 SVG 字形 + 角落一颗 acc 色小点；落位用 outBack（scale .6→1）。
- 词牌：Instrument Serif 104px（中文品牌名则 Noto Serif）。
- 关键词列：大字 display 47px + mono 12.5px 小注，竖线分隔，逐个 blur-in 错 0.1s。
- CTA 胶囊：ink 底 paper 字 18px，路径用 `→` 连接，产品名用 mono + 点睛色。
- 收尾：0.7s 淡至近黑（`#211b13`），音效留一个低 whoosh 收尾。
