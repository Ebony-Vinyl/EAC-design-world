# AI 调色指南（grading playbook）

EAC 的调色是**参数化**的：AI 修改一组参数（预设 + 曝光/对比/饱和/色温/色调 + 偏移/曲线/色相轮/分区/二级），引擎把参数确定性烘焙成 `.cube` 3D LUT，渲染时用 `lut3d` 套用。预览对比表、成片渲染、导出给剪映 / Premiere / Photoshop / DaVinci 的 LUT 使用**同一份**调色链与同一批 `.cube` 文件，因此预览与成片的调色观感一致（同一 LUT、同一参数、同一顺序）。

边界要说清楚：

- **一致的是调色本身**，不是画面全部。预览帧在 480×270 的边界内保持项目画布比例下采样后统计与展示；左右两侧使用相同运镜和构图，成片按项目分辨率渲染；构图/缩放/蒙版几何一致，但像素密度不同，锐化、暗角、柔光、字幕等"成片润色"只出现在成片里。
- **预览表右列是"当前调色"**：与成片一样套用 `inputLut → lut → 参数调色 → 局部窗口蒙版` 整条链，所以带蒙版或外部 LUT 的镜头在预览里就能看到真实效果。
- **色彩精度**：调色 LUT 在解码位深上运行（10-bit 源不会先被压成 8-bit 再调色，实测陡曲线下可保留 148 级 vs 压到 8-bit 的约 24 级），内部蒙版合成在 16-bit RGB 平面上完成；**但最终交付仍是 8-bit 4:2:0 H.264**（`yuv420p`），本项目不做 HDR / ACES / 广色域管线，也不写色彩元数据或做色域转换。
- **宿主软件**：导出的是 `.cube` 文件，宿主是否、如何应用它取决于宿主；`.cube` 的数值是确定性的，但宿主自己的输入色彩管理、素材解码、LUT 插值设置都可能带来差异。

## 参数一览（`clip.grading` 与项目级 `look` 同构）

| 参数 | 范围 | 作用 |
| --- | --- | --- |
| `preset` | 预设 ID | 风格起点；其余字段在其基础上覆盖 |
| `exposure` | -2..2 | 曝光（档） |
| `contrast` | -1..1 | 围绕 0.435 枢轴的对比 |
| `saturation` | -1..1 | 全局饱和（-1 为黑白） |
| `vibrance` | -1..1 | 智能饱和：低饱和像素提得多，不易过艳 |
| `temperature` | -1..1 | 色温：正暖负冷 |
| `tint` | -1..1 | 色调：正向品红，负向绿 |
| `lift/gamma/gain` | 每通道 | 暗部（offset）/中间（power）/高光（slope）的 RGB 分离调色 |
| `offset` | -0.5..0.5 | ASC-CDL 主偏移，加在 lift/gamma/gain 之后、对比之前（默认 0） |
| `curves` | `{ master?, r?, g?, b? }` | 曲线：每条 2..8 个 `[x, y]` 控制点（x/y ∈ 0..1，x 严格递增，首尾 x 必须是 0/1），Fritsch–Carlson 单调三次插值，不越界；对比之后、饱和之前逐通道套用，先 master 再 r/g/b |
| `hueShift` | -180..180（度） | 全局色相旋转，在饱和/自然饱和之后 |
| `hueVsHue` | 2..8 个 `[锚点0..360, δ -90..90]` | 色相 vs 色相：按锚点线性插值（0..360 循环回绕）旋转对应色相 |
| `hueVsSat` | `[锚点0..360, δ -1..1]` | 色相 vs 饱和：按像素**原始**色相查表，饱和度 ×(1+δ) |
| `hueVsLum` | `[锚点0..360, δ -1..1]` | 色相 vs 亮度：δ 1 → +0.25 亮度（按原始色相查表，最后套用） |
| `lumVsSat` | `[锚点0..1, δ -1..1]` | 亮度 vs 饱和：按像素亮度查表（端点外保持端点值），围绕 Rec.709 亮度缩放饱和度 |
| `zones` | `{ shadows?, midtones?, highlights?, shadowRange?, highlightRange? }` | log 轮风格：按**输入像素亮度** smoothstep 加权（边界 ±0.12 羽化；`shadowRange` 0.1..0.6 默认 0.3，`highlightRange` 0.4..0.9 默认 0.7），把各区 adjustment（`exposure/contrast/saturation/hueShift/lift/gamma/gain` 的子集，相对中性的偏移）折进对应全局步骤；全中性 = 无操作 |
| `secondaries` | 0..4 个 `{ qualifier, adjustments }` | HSL 限定器二级调色：`qualifier` 必含 `hue` 0..360 与 `hueWidth` 5..180（硬边 + `softness`×90° 软落），`satMin/satMax/lumaMin/lumaMax` 0..1（默认 0/1/0/1，`softness` 0..0.45 默认 0.08 做软落）；mask = 色相×饱和×亮度三个软隶属度的乘积。`adjustments` 支持 `exposure/contrast/saturation/vibrance/hueShift/lift/gamma/gain`（不支持 temperature/tint/offset），按 mask 混合叠加在基础结果上（mask 0 = 不变，1 = 完全生效），多个二级按顺序链式处理 |

处理顺序：白平衡 → 曝光 → lift/gamma/gain → offset → 对比 → 曲线 → 饱和 → 自然饱和 → 色相（hueVsHue 与 hueShift 旋转色相；hueVsSat 按原始色相；lumVsSat 按当前亮度；hueVsLum 最后加亮度）→ 二级（逐个按 mask 叠加）。所有输出最终钳制到 0..1，全程无 NaN，LUT 生成完全确定。

合并规则：`mergeGrading(project.look, clip.grading)` —— 项目 look 做底，片段标量字段（含 `offset`/`hueShift`）逐项覆盖，lift/gamma/gain 逐通道覆盖；**结构化字段（`curves`/`hueVs*`/`lumVsSat`/`zones`/`secondaries`）只要后一层包含该字段就整体替换前一层**（不按通道/分区/条目合并；显式 `null` 表示清空该字段）。

## 外部 LUT 与顺序（`clip.inputLut` / `clip.lut`）

两个字段都是可选的本地 `.cube` 路径，都是**整幅套用**（不是蒙版）：

| 字段 | 语义 | 顺序 |
| --- | --- | --- |
| `clip.inputLut` | 相机/厂商官方输入转换（例如 Sony S-Log3 → 显示 gamma）。用厂商提供的 `.cube`，EAC 不内置、也不推测任何 log 曲线公式。 | 最先，在一切调色之前 |
| `clip.lut` | 风格/胶片模拟 look LUT（原有字段，语义不变）。 | `inputLut` 之后、参数调色之前 |

完整顺序：`clip.inputLut → clip.lut → mergeGrading(look, clip.grading) → 局部窗口（每个蒙版用 mergeGrading(look, grading, window.grading)）`。这条链在**渲染和调色预览中共用同一实现**，所以窗口镜头不会丢掉两个 LUT。

`inputLut` 缺失而素材确实是 log 时，画面会显得灰、平；此时应让用户提供相机官方转换 LUT，而不是靠提对比"硬凑"。时间线保存时会校验 `inputLut` 与 `lut` 的 `.cube` 结构、DOMAIN 范围与数据完整性，但不识别相机曲线或验证色域匹配；渲染由 FFmpeg `lut3d` 应用文件。

## 迭代协议（必须走，不许一次定稿）

1. `job_submit type=grade-preview` 先看**原始画面**（未调色时右列=原片），判断素材问题：欠曝/过曝、灰雾、偏色、饱和不足。返回的 `frames[]` 每行带 `clipId`（片段 `id`，缺省用索引字符串）与 `clipIndex`，以及 `inputLut`/`lut`/`windows` 标记，供 `suggestShotMatch` 等工具按片段定位。
2. 选预设起点（风景片常用 `clean-landscape` / `alpine-crisp` / `golden-hour` / `teal-orange`），用 `timeline_update` 提交 `look`（全局统一）或个别片段 `clip.grading`（特殊镜头）。
3. 再次 `grade-preview`，用视觉能力审对比表：**每行左列原始、右列调色**，行序=片段序，同片段多行均匀取样；右列已包含外部 LUT 与局部窗口效果。
4. 结合统计护栏（返回值 `frames[].graded`：`lumaMin`/`lumaMax`/`lumaAvg`/`saturationAvg`/`highlightClip`/`shadowCrush`）与 `warnings` 修参数。
5. 最多 4 轮；终止条件：观感明显提升且无护栏告警。禁止在未看图的情况下宣称调色完成。

## 风景片审美要点

- **天空不过曝**：YMAX≥250 的行必须处理（降 exposure 或 gain.b）；有云的天空保留层次比提亮更重要。
- **暗部不死黑**：YMIN≤5 且原片不如此 → 提 lift 或降 contrast；剪影镜头除外（可有意保留）。
- **统一性**：多镜头平均亮度差 >38 会被预览护栏点名（曝光匹配另对同一镜头多帧亮度跨度 >25 标为不稳定）；用项目级 look 统一底色，再对个别镜头微调。
- **色彩情绪**：清晨/雪山偏冷（temperature -0.1~-0.25），黄昏/草原偏暖（+0.15~+0.3）；青橙对比（阴影偏青 + 高光偏暖）最稳妥的"电影感"。
- **饱和克制**：饱和均值 >0.45 通常已过艳；优先 vibrance 而非 saturation。
- **白平衡优先**：先修 temperature/tint 让中性物（雪、云、灰岩）归中性，再谈风格化。

## 高级工具的使用时机

- **`curves`**：整体影调微调（提中间调、压高光）首选曲线；x 轴是输入、y 轴是输出，控制点单调插值保证不产生怪异反差。
- **`hueVs*` / `lumVsSat`**：局部色彩问题用它们而不是全局参数——例如 `hueVsHue: [[210, -30], [270, -30]]` 只把蓝天往青压，`hueVsSat: [[90, 0.3], [150, 0.3]]` 只让植被更浓。锚点曲线在 0..360 上循环回绕，跨 0° 的色段也能连续插值。
- **`zones`**：亮度三段（阴影/中间/高光）需要不同曝光或饱和时用；权重自动羽化，不必手工做亮度蒙版。
- **`secondaries`**：精确到某个色相（如只提灯笼的红、只救天空的蓝）时用；`hueWidth` 控硬边、`softness` 控过渡，`satMin > 0` 可避免灰部被误伤。最多 4 个，从大到小排。
- **`offset`**：整幅统一提/压（如夜景整体抬一点蓝），比 lift 更"直"，不衰减。

## 预设参考

`GRADING_PRESETS`（`src/media/grading.mjs`）内置风格包：清透风景、青橙电影、黄金时刻、冷调雾蓝、胶片暖褐、高山清冽、森林翠绿、沙漠尘金、北欧灰调、银盐黑白，以及浓艳风光（`showcase-vivid`）、都市夜景（`neon-night`）、灯火楼阁（`lantern-night`）。预设只是起点，叠加参数微调才是常态。

## 导出

`job_submit type=export` 会把 look 与每个片段的调色分别导出为 `.cube`：剪映（调节 → LUT → 导入）、Premiere（Lumetri → Creative → Look）、DaVinci（节点 → LUT）、Photoshop（颜色查找调整图层）均可直接加载。这些 `.cube` 只包含参数调色（look + clip grading，窗口另有 `grade<片段>w<蒙版>.cube`），**不把** `clip.inputLut` / `clip.lut` 的数据合并进参数 LUT；导出目标包含 `lut` 时，这两个外部文件另行复制到交接包的 `lut/input/` 与 `lut/creative/`。续剪时需按交接清单先加载输入转换、再加载风格 LUT、最后加载参数调色 `.cube`；空间蒙版还需重建。宿主自身的色彩管理不在 EAC 控制范围内。
