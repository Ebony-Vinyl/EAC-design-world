---
name: motion-promo-film
description: 用「HTML/CSS/JS 确定性时间轴 → 无头浏览器逐帧抓帧 → ffmpeg 合成」制作产品动效宣传片（dsh-ops / onetake 风格：衬线大字幕、UI 实机演示、配乐音效、编号分节结构；多主题配色，可从参考视频取色）。Use when 用户要求制作或复刻产品宣传片 / 动效演示视频 / motion promo，提到 "onetake 风格"、"dsh-ops 风格"、UI 动画成片、逐帧渲染视频，或给出参考视频要求学习其剪辑风格并产出同风格成片。不适用于：实拍素材剪辑、纯拼接剪辑、3D 动画。
---

# Motion Promo Film — 动效宣传片生成技能

目标：从参考视频 + 素材出发，产出一部 **60 秒左右、1920×1080@30fps、带配乐音效** 的产品动效宣传片 MP4。

## 核心思路

不做视频剪辑，而是**把整部片子写成一个确定性的 HTML 动画**（所有画面状态都是时间 t 的纯函数），再用无头浏览器逐帧截图，最后 ffmpeg 合成 + Python 合成音轨。这样每个点击、每行流式文字、每个数字滚动都能精确对齐节拍，且可无限次重渲。

```
参考片+素材 → 逐帧拆解 → 分节脚本(beat sheet)
    ↓
film.html（确定性时间轴，window.__seek(t) 渲染任意帧）
    ↓ Playwright + Edge headless，逐帧 screenshot
1800 张帧图 → ffmpeg (+ audio.py 合成的音轨) → 成片 MP4
```

## 文件地图（本目录）

| 文件 | 用途 | 什么时候读 |
|---|---|---|
| `STYLE.md` | 风格 DNA：配色、字体、字幕系统、运动规律、叙事模板 | 动手写 film.html 之前必读 |
| `RUNBOOK.md` | 逐步操作手册（10 步，含全部命令与每步的验收门槛） | 全程照着走 |
| `PITFALLS.md` | 实战中踩过的坑与修法（坐标映射、裁剪、字体、截图…） | 卡住时先查这里 |
| `templates/film-template.html` | 可运行的最小骨架（12s 演示片，含全部引擎系统） | 复制它作为起点 |
| `templates/film-template-plus.html` | **进阶版骨架**：同一结构，动效接入 onetake 的 `OM` 动效库 | 要"牛动效"时用它 |
| `templates/lib/motion.js` | onetake 动效库（OM）：弹簧、逐字、冲击、按压、样条光标、摄像机 —— 全是 t 的纯函数 | plus 版引用 |
| `templates/lib/POLYFORM-NOTE.md` | motion.js 的来源与许可（**PolyForm NC：仅限非商业**） | 商用前必读 |
| `templates/render.js` | 逐帧抓帧脚本（--smoke 冒烟 / 全量两种模式） | 直接用 |
| `templates/audio.py` | 配乐+音效合成（numpy 纯手写，事件表需按时间轴重排） | 直接改 |
| `templates/fetch_fonts.py` | 字体获取（国内镜像，CJK 按 unicode-range 裁剪） | 直接用 |
| `templates/qc.py` | 无视觉质检（帧亮度健康检查，适合没有读图能力的模型） | 可选 |
| `reference/film-our-free-model.html` | 完整参考实现：Our Free Model 插件 60s 成片源码 | 写复杂场景时对照抄 |
| `reference/audio-our-free-model.py` | 60s 完整音效事件表范例 | 排布音效时对照 |

## 硬规则（违反必返工）

1. **一切都是 t 的纯函数**。禁止 CSS transition/animation/@keyframes、禁止 requestAnimationFrame、禁止渲染期 Math.random。`window.__seek(t)` 必须能同步渲染出任意一帧且幂等。
2. **先写 beat sheet 再写代码**。每个分节的起止时间、字幕文案、UI 动作、光标路径、音效点，先列成表格定稿。
3. **冒烟后必须看图**。全量渲染前用 `--smoke` 出 20~30 张关键帧并逐张查看（没有读图能力就用 `templates/qc.py` 的亮度体检兜底）。坐标映射错误、元素被裁剪只有看图能发现。
4. **摄像机数学先验算**（见 PITFALLS §1）：`screen_x = s·(p_x−960) + (1920−cx)`，可视世界范围 `x ∈ [960−(1920−cx)/s, 960+cx/s]`。写完 CAM 键后把每个分节的可视范围算一遍，确认目标 UI 都在框内。
5. **字体必须等加载完成**再出第一帧（`document.fonts.ready`），否则首批帧全是回退字体。
6. **颜色一律走 CSS 变量**，`film.html` 里禁止硬编码色值。配色是一个**主题**，不是定式：内置「奶油纸感」（Theme A）与「深色科技」（Theme B）两套，也可以从用户给的任何参考视频自动取色生成主题 R（流程见 STYLE.md §1.3）。换主题 = 换一个 `:root` 块，其他代码不动。
7. 时长基准：4~6 个功能点 25~35s；7 个以上 45~75s。30fps，1080p。

## 三档动力（按需选，同一套渲染管线）

| 档 | 用什么 | 适合 |
|---|---|---|
| 基础 | `film-template.html` 自带的手写缓动（outExpo/outBack/inOut + T/capIn/pop/typeInto） | 简洁克制、改起来最快 |
| **进阶** | `film-template-plus.html`：`<script src="lib/motion.js">` 引入 onetake 的 **`window.OM`** —— `OM.camera/view`（对数缩放摄像机+CSS matrix）、`typeOn`（打字）、`popIn`（弹簧入场）、`wordRise`（按词起）、`letterDrop`（逐字落地压扁回弹）、`impact`（落地冲击挤压）、`press`（按钮按压回弹+闪烁）、`cursor`（样条光标+点击下压）。全部是 t 的纯函数，与 `__seek` 完全兼容 | 要 onetake 那种"牛动效"但保持轻量单文件 |
| 全家桶 | 直接用已安装的 `onetake` skill（oracle 质检、多概念比稿、4K60 渲染管线） | 大项目，非商业用途 |

plus 版注意：① `#world` 必须 `transform-origin:0 0`，用 `OM.view(cam)` 返回的 matrix 直接做 transform；② `OM.ease` 的命名是 `cubicOut`（无 outCubic）；③ 动效库许可为 PolyForm Noncommercial，**商用需授权**或退回基础档。

## 最短可用路径

```bash
# 0) 环境：node + 全局 playwright(NODE_PATH 指到全局 node_modules) + Edge + ffmpeg + python(numpy, fonttools, brotli)
cp templates/film-template.html my-film.html     # 改内容
python templates/fetch_fonts.py my-film.html     # 字体落位 fonts/
node templates/render.js --smoke --film my-film.html   # 看图修正
node templates/render.js --film my-film.html     # 全量 ~5min/60s
python templates/audio.py                        # 先把事件表重排到自己的时间轴
ffmpeg -y -framerate 30 -i out/f_%05d.png -i audio/bed_norm.wav \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart 成片.mp4
```

> render.js / audio.py 的完整参数与内部约定见 RUNBOOK.md §5、§7。
