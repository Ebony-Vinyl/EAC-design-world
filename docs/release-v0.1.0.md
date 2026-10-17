# EAC design world v0.1.0 · 开发预览版

DeepSeek Harness 本地视频制作与设计插件的首个公开版本。

## 下载

- **plugin.zip**：插件与后端源码、预构建 Web UI、模板源码、设计体系、真实封面、安装脚本和许可说明。需要自行安装 Node 依赖。
- **media.zip**：可选 MG 预览视频、字体、渲染素材及工作台 65 秒宣传片。合并解压到 plugin.zip 同一目录。
- **SHA256SUMS.txt**：下载校验。

两个 ZIP 根目录均为 `eac-design-world/`。媒体包不包含 Node、Python、FFmpeg 或 Whisper 模型。

## 安装

```powershell
cd eac-design-world
npm ci --omit=dev
npm run doctor
node scripts/install-harness.mjs --dry-run
node scripts/install-harness.mjs
```

重新加载 Harness。也可 `npm start` 后打开 `http://127.0.0.1:4173` 独立使用。

## 本版内容

- 正常、剪辑和 Design 模式，会话独立选择与可移除缩略图标签。
- 主内容区宽度的两行模板推荐，头像 Logo 与标题居中，真实页面封面。
- 152 套设计体系、517 个 OpenDesign 模板条目、169 项技能、13 个基础组件、14 个场景；另有原有 17 个视频选项。
- 网页与 Windows 桌面录制、多轨时间线、配音配乐、转录字幕、H.264 输出和技术检查。
- HTML/SVG/Markdown 设计作品、版本历史、隔离预览与 Harness 原生右侧画布。
- PDF/PNG 导出，以及 HTML 幻灯片的整页图像 PPTX 导出。
- 顶部导航工作台、固定 65 秒宣传片预览。

## 已知边界

- 本版为开发预览，优先支持 Windows。SAPI 与桌面录制仅支持 Windows。
- 205 项模板条目需要外部模型生成；HyperFrames 子合成与远程模型供应商没有整体嵌入。
- PPTX 是整页图像导出，不等于逐元素 PowerPoint 编辑。保留 HTML 工程用于编辑。
- 语音转录需自行安装 Python/faster-whisper 和本地模型；未携带模型。
- 技术检查不等于艺术质量验收。字体、用户素材和 Blender 帧缺失时需要补充。
- PolyForm 可选库和两个无明确再分发许可的原始提示词/预览图不在公开产物中。

## 验证记录

- 生产构建通过。
- 完整回归 105 项中 104 项通过，浏览器取消测试在并行运行中触发耗时断言；随后该测试单独重跑通过。保留这个已观察到的时序敏感限制，不将首次完整回归写成全通过。
- 发布前补充验证插件、设计接口、内容库、筛选和解压产物；具体结果以本版发布时记录为准。

源代码许可为 AGPL-3.0-or-later，第三方部分保留独立许可证。详情见 README 与 THIRD_PARTY_NOTICES.md。
