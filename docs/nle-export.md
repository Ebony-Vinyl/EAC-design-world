# 剪辑工程导出（人工续剪）

`job_submit type=export`（`params.targets` 缺省导出全部）把 EAC 项目转成可继续人工剪辑的工程与素材包。导出完全在 Node 内完成，**不调用剪映 / Premiere / Resolve**，也不需要本机安装它们。

| 目标 | 输出 | 用途 |
| --- | --- | --- |
| `jianying` | `jianying/EAC <项目名>/draft_content.json + draft_meta_info.json` | 剪映专业版（CapCut 可参照的公开草稿结构） |
| `premiere-xml` | `premiere-xml/<项目名>-premiere.xml`（FCP7 xmeml） | Adobe Premiere Pro、DaVinci Resolve 直接导入 |
| `srt` | `srt/captions.srt` | 任何剪辑/字幕软件 |
| `lut` | `lut/look.cube`、`lut/clip-N-<素材名>.cube`、`lut/grade<N>w<M>.cube`，以及复制的 `lut/input/…`、`lut/creative/…` | 剪映调节-LUT / Premiere Lumetri / 达芬奇节点 / Photoshop 颜色查找 |
| `bundle` | `bundle/README.txt` | 各软件导入步骤、LUT 应用顺序、素材署名 |

除上述目标外，每次导出都会生成：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 源 revision、画布/帧率/时长、媒体清单（绝对路径、是否存在、大小、probe 帧率与时长）、LUT 清单、能力保留对照、notes |
| `<项目名>-handoff.zip` | 本次导出的全部文件（含 manifest 与草稿），一键下载移交 |

ZIP 由 `node:zlib` 直接写出（STORE/DEFLATE + CRC32，UTF-8 文件名），不新增依赖、不调用系统压缩工具。草稿与 XML 结构确定性生成；每次交接清单含生成时间，因此完整 ZIP 不承诺跨导出字节相同。

## 校验（失败即中止，不写任何文件）

`runExport` 在创建输出目录之前先校验：

- 时间线为空 → `时间线为空：没有可导出的片段（empty timeline）`。
- 任一片段、配乐 `musicPath`、旁白 `voicePath`、`clip.inputLut`、`clip.lut` 指向的文件不存在或不是普通文件 → 报错并逐条列出缺失项，提示恢复文件或在 EAC 中移除对应片段/调色。

`buildFcp7Xml` / `buildJianYingDraft` 是纯函数，只读取传入的项目 JSON（含 `assets[].probe`），不访问文件系统，因此可以脱离素材单独测试与预演。

## 剪映

- 若本机检测到剪映草稿目录（`%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft`，或在设置里显式配置 `jianyingDraftRoot`），引擎会把草稿文件夹**复制**进去。
- 草稿目录名默认是 `EAC <项目名>`；需要避免覆盖人工已续剪的草稿时，调用方可通过 `settings.draftName`（如 `EAC job-42`）指定唯一名称，`draft_meta_info.json` 的 `draft_name` 会同步。`draft_content.id` 与 `draft_meta_info.draft_id` 都包含该名称：同名重复导出是同一确定性身份，改名则视为新工程，不会被剪映当成同一草稿。
- 草稿引用的是**原始素材绝对路径**；移动或删除素材后需要在剪映中重新链接，`manifest.json` 记录了每个素材的原始绝对路径与 LUT 对应关系，可作为重链接依据。
- AI 参数调色不会烘焙进草稿画面，配套 `.cube` 已在 `lut/` 目录，在剪映里对片段套「调节 → LUT → 导入」即可复现成片色调（与渲染同源，色值一致）。
- **轨道布局**（剪映同轨片段不能重叠）：
  - 视频按 EAC 的 `clip.track` 分轨；同一 EAC 轨内若仍有时间重叠，会自动拆到额外 lane（各成一条视频轨）。
  - 素材源音不再由视频片段发声（视频片段 `volume` 固定为 0），每个可听片段（`volume > 0`）只有**一条**独立音频片段承载源音，避免双响。
  - 源音按原 `clip.track` 分轨，轨内重叠再拆 lane；配乐与旁白各自占用独立音频轨，永不与源音同轨。
  - 字幕同理：重叠字幕自动拆到多条文本轨。
- 变速：草稿原生写入 `speed` 与 `speeds` 素材；`musicStart` 写入音乐段源入点；`fadeIn`/`fadeOut` 写入音乐段 `audio_fades`。
- 新版剪映可能加密或改变草稿格式；本项目只对公开明文结构做格式验证，未在实际剪映版本中验证导入。若目标版本无法识别，仍可使用 XML/SRT/LUT 方案并人工核对。

## Premiere Pro / DaVinci Resolve

`文件 → 导入` 选择导出的 `-premiere.xml`（FCP7 XML）：

- **视频轨**：按 EAC 的 `clip.track` 保留层叠顺序，同轨重叠片段拆成互不重叠的额外轨道。
- **音频轨**：素材源音（video/audio 片段中 `volume > 0` 的部分）、配乐、旁白分别占用**独立音频轨**，便于人工单独调整；配乐与旁白的源入点分别对应 `musicStart` 与 0。
- **变速**：非 1 倍速片段写入真正的 `<filter><effectid>timeremap</effectid>`，含 `speed`（百分比）、`variablespeed=0`、`reverse=FALSE`、`frameblending=FALSE`；同时 `in/out` 仍按 `时长 × speed` 展开，二者一致。1 倍速片段不写该滤镜。
- **媒体时基**：源入出点使用素材帧率（来自 `assets[].probe.fps`，支持 `"25/1"` 等字符串），NTSC 素材使用相应整数 timebase 与 `ntsc=TRUE`；序列与片段的目标起止仍使用项目帧率。没有 probe 数据时按项目帧率假定。
- **音量与变速**：音频片段与视频使用相同速度描述，音频增益写入 XML；配乐使用 0.22 倍增益。目标软件的响度归一和侧链处理仍需人工核对。
- **循环配乐**：根据已探测的真实音乐长度，将源偏移取模并按循环边界拆段，不通过增加声明时长伪造更长媒体。
- 调色：Lumetri（PR）/ 节点 LUT（Resolve）加载 `lut/` 中对应的 `.cube`。

## 外部 LUT：实际复制，不是模拟

`clip.inputLut`（相机输入转换，例如 Log → Rec.709）与 `clip.lut`（创意风格 LUT）指向用户自己的 `.cube` 文件。导出时会**实际复制**到：

- `lut/input/clip-<序号>-<素材名>.cube`（`inputLut`）
- `lut/creative/clip-<序号>-<素材名>.cube`（`lut`）

每个片段的正确应用顺序（README 与 manifest 均写明）：

```
inputLut（输入转换） → lut（创意风格） → 分支
  基础分支：lut/clip-N-*.cube（无单独片段调色时使用 look.cube）
  窗口分支：从相同的分支前输入加载 lut/grade<N>w<M>.cube
  合成：按窗口的几何、羽化和 opacity 将窗口分支与基础分支混合
```

外部输入与创意 LUT 各执行一次，再分支调色；片段 LUT 已合并项目 look，窗口 LUT 已合并项目 look、片段参数与窗口参数。**不要在基础 LUT 之后串联窗口 LUT，也不要再给片段 LUT 叠加 look.cube**，否则基础调色会重复。窗口几何需在目标软件手动重建，按交接清单中的片段和窗口映射、羽化、opacity 合成。

## 时间线能力对照

| 能力 | 剪映 | Premiere / Resolve | 说明 |
| --- | --- | --- | --- |
| 变速 `clip.speed` | 原生写入（片段变速），导入即生效 | XML `timeremap` 滤镜（speed 百分比）；若版本忽略该滤镜，用「速度/持续时间」按同一比值设置 | 时间线时长不变，源范围 = 时长 × speed |
| 动画 `clip.motion` | 需人工重建 | 需人工重建 | 仅渲染引擎生效，**不保留** |
| 空间蒙版 `clip.windows` | 需人工重建 | 需人工重建 | 几何形状**不保留**；每个蒙版的合并调色导出为 `lut/grade<片段>w<蒙版>.cube` |
| 锐化 / 暗角 / 颗粒 | 需人工重建 | 需人工重建 | 仅渲染引擎生效，**不保留** |
| 曲线 / 二级调色 / 分区 / hue-vs | 套用对应 `.cube` LUT | 套用对应 `.cube` LUT | 已烘焙进导出的 LUT，无需重建 |
| 相机输入 `inputLut` / 创意 `lut` | 复制文件 + README 顺序 | 复制文件 + README 顺序 | 实际复制，需按顺序人工加载 |
| 音乐偏移 `musicStart` | 音乐段源入点已写入 | XML 音乐轨入点已写入 | 音乐从该偏移开始播放 |
| 淡入淡出 `fadeIn`/`fadeOut` | 音乐段 `audio_fades` 已写入 | 需用音量关键帧手动复现 | 作用于音乐床 |
| 字幕 | 草稿文本轨 | 不写入 XML；使用 SRT | SRT 可供所有软件导入 |

## 验证边界

导出只做**格式验证**：XML 结构良构、草稿字段符合公开明文结构、LUT 文件可读可复制。`manifest.json` 中固定写明：

```json
{ "formatValidation": "format-only", "verifiedInNle": false }
```

**没有在真实剪映 / Premiere / Resolve 中导入验证**，也不能宣称效果被全自动保留。导入后请人工核对剪辑点、变速、LUT 顺序与音频轨，并继续人工续剪与导出。

## Photoshop

对视频帧或海报图：`图层 → 新建调整图层 → 颜色查找`，载入 `lut/look.cube` 即可得到与成片一致的调色；需要相机输入转换时先加载 `lut/input/` 下对应文件。

## 必剪（BiJian）

必剪草稿为封闭格式、与剪映不互通，暂不能直出工程。替代方案：使用导出的 MP4 成片 + `srt/captions.srt`（必剪支持导入字幕）+ `lut/*.cube`（必剪支持 LUT 导入）继续人工制作。

## 素材许可

联网下载的素材（Pexels/Pixabay/维基共享/Jamendo）在素材条目上记录 `source: {provider, author, license, url}`；导出包 README 汇总署名。发布成片时请保留对应署名（CC 系列许可为强制要求）。
