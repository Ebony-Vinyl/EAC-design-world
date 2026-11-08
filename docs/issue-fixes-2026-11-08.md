# GitHub issue 与 PR 处理记录（2026-11-08）

对应 2026-11-08 读取到的全部开放反馈：[#16](https://github.com/Ebony-Vinyl/EAC-design-world/issues/16)、[#14](https://github.com/Ebony-Vinyl/EAC-design-world/issues/14)、[#13](https://github.com/Ebony-Vinyl/EAC-design-world/issues/13)、[#12](https://github.com/Ebony-Vinyl/EAC-design-world/issues/12)、[#6](https://github.com/Ebony-Vinyl/EAC-design-world/issues/6)、[#5](https://github.com/Ebony-Vinyl/EAC-design-world/issues/5)、[#4](https://github.com/Ebony-Vinyl/EAC-design-world/issues/4)，以及 [PR #2](https://github.com/Ebony-Vinyl/EAC-design-world/pull/2)、[#15](https://github.com/Ebony-Vinyl/EAC-design-world/pull/15)、[#17](https://github.com/Ebony-Vinyl/EAC-design-world/pull/17)。上一轮的 #4/#5/#6 记录见 [issue-fixes.md](issue-fixes.md)。

## #16：转录默认模型硬编码，PyAV 19 不兼容

**已修复。**

- `src/transcript.mjs` 的默认模型改为 `join(EAC_DATA_DIR || ROOT/.eac, 'models/faster-whisper-tiny')`，与 README 描述一致。`EAC_WHISPER_MODEL_PATH` 仍然优先；此前默认值 `D:\hf-cache\...` 是作者本机路径，在其他机器上转录必然不可用。
- `scripts/transcribe.py` 新增 `open_container(av, path)`：先带 `metadata_errors="ignore"` 调用，遇到 `TypeError` 再退回无该参数的形式，因此 PyAV 18 与 19 都可运行，不再必须锁定 `av<19`。
- `scripts/doctor.mjs` 增加「本地语音转录（可选）」一项，缺失时直接输出应放置模型的目录，不必再从 `eac_status` 的 capabilities 里翻找。
- `tests/transcript.test.mjs` 新增两条断言：默认路径落在用户数据目录且不含 `hf-cache`；`EAC_WHISPER_MODEL_PATH` 仍可覆盖。另有 `open_container` 的新旧签名兼容测试。依赖真实模型的用例在未安装模型时跳过，不再因为机器路径而失败。

## #12：Composer CSS 覆盖导致其他插件无法输入

**已修复。** `plugin/client.js` 删除了三条对宿主 composer 的 `!important` 覆盖：

```css
[data-composer-card]:has(.eac-composer-controls) { height:auto!important; min-height:0!important; flex-grow:0!important; ... }
[data-composer-card]:has(.eac-composer-controls) [data-input-scroll] { ... flex:0 1 auto!important }
[data-composer-card]:has(.eac-composer-controls) [contenteditable][data-placeholder] { ... }
```

`min-height:0` 与 `flex-grow:0` 会把复用宿主 composer 的插件（如 ds-bot）输入区压成 0 高度，导致无法聚焦输入。现在插件只为自己注入的 `.eac-composer-controls` 及其子元素设样式。

`tests/plugin.test.mjs` 新增回归测试，直接断言源码中不存在上述三类 `!important` 覆盖，同时保留控件自身样式的存在性检查。

`scripts/verify-open-design.mjs` 的原断言（原生编辑器被压到 ≤56px 再随文本增高）正是这一覆盖行为，已改为验证新契约：插件不得改变宿主给定的 260px / 180px 尺寸，且控件仍然渲染。

## #14：smoke / demo-film 导航选择器失效（由 PR #15 修复）

**已合并。** 选择器从 `nav .nav-item` 更新为 `nav .topnav-item`，设置按钮从 `button[aria-label="打开设置"]` 改为 `.topnav-item.settings-item`。

实机验证：`node scripts/smoke.mjs` 完整跑通 `record-browser → compose → voice → render → 剪辑与混音 → completed`，产物 ffprobe 为 H.264 1280×720 / AAC 48000Hz 双声道 / 11.4s，`artifacts/validation/report.json` 的 `uiErrors` 为空数组。

## #13：更方便的视频编辑工作台

**已增量实现。** 时间线轨道上的片段现在支持直接操作：

- 拖动片段主体移动 `start`，时长保持不变；
- 拖动左边缘同时调整 `start` 与 `sourceIn`，保证同一段素材仍在光标下；
- 拖动右边缘调整 `duration`。

拖拽结果实时写回上方的数值输入框，保存时仍以输入框的数值为准，因此原有的精确输入方式没有被削弱。`tests/export-ui.test.mjs` 新增 Playwright 用例，用真实鼠标事件覆盖三种手势，并在保存后校验项目状态。

这是一个可用的起点而不是完整 NLE：多轨拖拽换轨、波形对齐、快捷键与撤销栈尚未实现。

### 复查后对拖拽的修正

初版拖拽实现有四处会在真实使用中暴露的问题，复查时逐条修好，并补了对应断言：

- **`sourceIn` 每次指针移动都累加**：`continueDrag` 用 `row.sourceIn`（当前 state）加 `shift`，而 `shift` 是从手势起点算的绝对量，于是每移动一次就多叠一次。实测把片段头部向右拖 10 步，`sourceIn` 从 1 变成 1.99（应为 1.18），音画从此不同步。现在三种手势都只读手势开始时快照的值。
- **`sourceIn` 可以被拖成负数**：向左拖头部只夹了 `-drag.start`，没有夹到素材入点，实测 `sourceIn` 到过 -1.32，保存时被服务端以「数值必须在 0 与 3600 之间」拒绝。现在下界取 `max(-start, -sourceIn)`。
- **向右拖尾部可以超过素材长度**：没有上界，实测 4 秒素材被拖到 3.26 秒 + 入点 1 秒，保存同样被拒。现在按 `(素材时长 - 入点) / 变速` 封顶。
- **拖拽结束会触发按钮的 `onClick` 把页面平滑滚动到片段编辑器**，视图在拖拽刚结束时就跳走，下一次手势落在错误位置。现在记录手势是否真的移动过，移动过就不再响应这次 click。
- 另外时间线总长原本每帧从 state 重算，片段变长会让同一个像素位移对应更多秒，手势中途「加速」。现在在手势开始时冻结。

`tests/export-ui.test.mjs` 的拖拽用例已扩到覆盖上述边界：断言 `start` 与 `sourceIn` 同步位移、头部裁剪后时长等量缩短、尾部裁剪不超过素材长度。

## 复查本轮提交时发现的其他问题

- **`scripts/verify-open-design.mjs` 的 composer 断言恒不成立**（P1，随 #12 修复引入）。fixture 的 `[data-composer-card]` 是 `content-box`，声明的 `height: 260px` 加上 8px 内边距与 1px 边框后实测 278px，而断言直接比较 260。脚本在本机任何时候都会失败，与产品行为无关。现改为断言内容高度仍为 260，并按实际内边距/边框推导外框高度。
- **两个 UI 用例在并行跑全量时随机超时**（`export-ui` 首个用例、`settings-secrets-ui` 保存用例）。Vite 首次转换 `main.jsx` 在本机要 20–40 秒，期间点击会落在连接横幅上，导出结果卡片还要等 2.5 秒的状态轮询；默认 60 秒超时在负载下不够。现在这两个用例先等 `nav-count` 真正拿到模板数量（真实就绪信号）再点击，并放宽结果卡片的等待。单独跑与全量跑均通过。
- **`src/engine.mjs` 里 `browserCandidates()` 是死代码**：PR #2 引入后并未接入 `capabilities()`，后者走 `src/browser.mjs` 的 `browserLaunchOptions()`。已删除，避免两套浏览器探测逻辑分叉。

## 验证结果（本轮复查后重跑）

| 项目 | 结果 |
| --- | --- |
| `npm test` | 403 项；397 通过、6 跳过（缺本地 Whisper 模型与平台相关）、0 失败 |
| `npm run build` | 通过 |
| `npm run smoke` | 真实录制 → 配乐 → 旁白 → 渲染 → 混音完整通过；产物 H.264 1280×720 / AAC 48000Hz 双声道 / 12.0s，`uiErrors` 为空 |
| `npm run doctor` | 除未配置的 API Key 与未安装的转录模型（可选）外全部通过 |
| 写锁接管实测 | 强杀后 54ms 接管，锁与 pid 文件清理干净 |
| composer 契约实测 | 原生编辑器 180px、卡片内容高度 260px（外框 278px）均未被插件改动 |


## PR #17：强杀宿主后遗留写锁

**已合并。** 宿主被强杀时不会执行 dispose，`.writer.lock` 留在数据目录；`proper-lockfile` 只在 120 秒 stale 后才回收，而重启远快于此，于是新宿主整个运行期都无法激活。

修复在锁旁边记录持有者 pid：拿锁成功后写 `.writer.pid`，释放时删除。遇到 `ELOCKED` 时读回 pid，持有进程已不存在就立即接管并重试一次；pid 未知（旧版本遗留锁）或进程仍存活时照旧失败，不抢活锁。

实测：子进程持锁后被 `SIGKILL` 强杀，新进程 **85ms** 完成接管（原本需等待 120 秒），关闭后 `.writer.lock` 与 `.writer.pid` 均被清除。`tests/data-lock.test.mjs` 覆盖「持有者已消失立即接管」「无 pid 记录仍失败关闭」与原有的多进程互斥。

同一 PR 的第二个提交让「空选择 + normal 模式」的同步失败不再弹出「选择未能同步」——用户此时并没有选过模板，误报反而掩盖了服务未启动这一真实原因。

## PR #2：macOS 桌面录制

**解决冲突后合并。** 该 PR 基于 v0.4.0，与 v0.6.0 在 `README.md`、`src/engine.mjs`、`src/media/index.mjs` 冲突。处理方式：

| PR 内容 | 处理 |
| --- | --- |
| `browserCandidates()` 平台化浏览器探测 | 未采纳：v0.6.0 的 `src/browser.mjs` 已提供统一的 `browserLaunchOptions()`，覆盖 macOS / Windows / Linux 且带 `EAC_BROWSER` 校验 |
| macOS `say` 旁白（AIFF → FFmpeg） | 未采纳：v0.6.0 已用 `say -f ... --file-format=WAVE` 直接产出 WAVE，路径更短 |
| macOS avfoundation 桌面录制 | **已采纳**：设备索引自动发现（`-list_devices` 解析，`EAC_SCREEN_DEVICE` 可覆盖）、显式 `uyvy422`、Retina 宽度上限（`EAC_SCREEN_MAX_WIDTH`，0 为原尺寸） |

`capabilities()` 的 `desktop` 项现在在 darwin 上也可用，并给出对应说明。

## 测试基础设施修复

全量测试此前存在若干与产品逻辑无关的失败，本轮一并处理：

- **Windows 目录清理竞态**：约 95 处 `rm(dir, { recursive: true, force: true })` 补上 `maxRetries` / `retryDelay`。Defender 与搜索索引会短暂占用刚写入的文件，导致 `ENOTEMPTY`，表现为随机失败。
- **`tests/export-ui.test.mjs` 的共享状态污染**：「custom grading」「scalar controls」两个用例此前失败，因为它们在共享 fixture 项目上读写 `look` / `grading`，被前一个用例的残留影响。现改为各自创建独立项目。
- **选择预设后立即保存的竞态**：保存按钮在 React 收到 select 变更前仍是 disabled，点击会丢事件。用例改为先等按钮可用。
- **超时**：真实转码的导出用例与设置面板用例在机器负载高时会超过 180 秒，分别上调到 420 秒与 300 秒。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| `npm test` | 403 项；除依赖真实 Whisper 模型与平台相关的 6 项跳过外全部通过（本轮复查后为 397 通过 / 0 失败 / 6 跳过） |
| `npm run build` | 通过 |
| `npm run smoke` | 真实录制 → 配乐 → 旁白 → 渲染 → 混音完整通过，产物规格正确 |
| `npm run verify:npm` | pnpm 11.7.0 安装、链接启动、本地资源还原、UI 服务全部通过 |
| `npm run doctor` | 除未配置的 API Key 与未安装的转录模型（可选）外全部通过 |
| 写锁接管实测 | 强杀后 85ms 接管，锁与 pid 文件清理干净 |

本机未安装 Whisper 模型，因此真实 ASR 用例以跳过处理，未声称已验证转录质量。

`npm run verify:npm` 本轮未重跑（需要 pnpm 与联网安装），其余项目均在复查后重新验证。`scripts/verify-open-design.mjs` 的 composer 断言已修正并单独验证通过，但整个脚本在本机仍会因设计工作台页面的既有 15 秒默认超时而中断，该超时与本次改动无关。

