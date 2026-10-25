# Mac / Codex 本地 MCP 验收

日期：2026-10-25。仅本机开发验证，未发布 npm 或创建 PR。

## 已完成

- `npm ci`、`npm run build`：完成；`npm run doctor` 识别 Node 24、Homebrew FFmpeg/FFprobe、Python 3 和本机 Chrome。
- `node --test tests/local-mcp.test.mjs`：4 项通过，包含两个真实 STDIO 客户端同时启动、服务复用、目录冲突拒绝、按 Shotcraft ID 导入、Mac say 配音与无效声线拒绝。并发测试曾暴露端口探测竞争，修复后通过。
- `node --test tests/local-mcp.test.mjs tests/design-export.test.mjs tests/engine.test.mjs tests/motion-recording.test.mjs`：14 项通过、1 项 Windows 转录测试跳过；没有设置 EAC_BROWSER，实际使用自动发现的 Mac Chrome。
- 配置 Codex MCP 并通过新的 `codex exec --ephemeral --json` 会话完成 workspace_info、library_list、design_project_create、design_artifact_save、design_state 共 5 次真实 MCP 调用。没有把配置存在视为连接成功。
- 真实 MCP 媒体调用完成浏览器点击录制、Shotcraft 导入、时间线规划、系统 say 配音、本地器乐、视频渲染与自定义 HTML 确定性逐帧渲染。输出与技术报告真实存在，抽帧已目视检查；这是功能验收样例，不是完成创作的商业影片。
- Ego Browser 实际操作：搜索 blur-slide、播放预览（currentTime 增长，时长 4.3 秒）、打开 Codex 保存的页面、预览、导出 PNG 并下载。检查下载图像与工作台截图。
- `git diff --check`：通过。

## 全量测试边界

`EAC_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm test`：218 项，202 通过、4 失败、12 跳过。未宣称全绿。

4 个失败：

1. OpenDesign catalog 引用的 `vendor/open-design/design-systems/agentic/system/artifacts/deck.html` 不在当前检出目录。
2. plugin-json 测试假定可选 `motion-web-skill` 已安装，当前未导入其受限库。
3. transcript 的 invalid-input 测试假定默认 Whisper 模型存在，实际先返回模型缺失。
4. transcript 的静音/无音轨测试同样依赖未安装的默认 Whisper 模型。

12 项跳过涉及 Windows 专用功能、未安装的真实 DSH 内核/客户端包、可选动效库与本地 ASR。没有下载模型、导入受限库或修改测试断言掩盖失败。最终局部修正后重跑上述定向测试，而非再运行全量媒体套件。

npm audit 报告现有依赖 5 项漏洞（1 moderate、4 high），未进行无关的破坏性依赖升级。详细日志存于本地 artifacts/local-mcp-qa/，该目录被 Git 忽略。

## 接入与数据

已在本机 Codex 配置中添加 eac-design-world，使用绝对 Node 路径、绝对 MCP 启动路径及包含 FFmpeg 的 PATH。原配置已备份。新 Codex CLI 会话已验证接入；现有聊天可能需要重新加载 MCP。个人配置与备份不随源码提交。

工作台默认使用 http://127.0.0.1:4173，数据保存在用户数据目录。未安装登录项；MCP 断开后服务继续运行。桌面录屏仍仅 Windows，本机未配置 Whisper 模型。

## 本机证据

- `artifacts/local-mcp-qa/codex-exec.jsonl`：实际 Codex 工具调用与完成事件。
- `artifacts/local-mcp-qa/full-tests.log`：全量日志（含失败）。
- `artifacts/local-mcp-qa/focused-tests.log`、`local-tests.log`：定向测试。
- `artifacts/local-mcp-qa/media-results.json`：媒体任务完整结果与产物绝对路径。
- `artifacts/local-mcp-qa/workspace.png`、`exported.png`：工作台与下载图片。

## Windows 适配补充

同日将本地 MCP 的支持目标扩展为 macOS + Windows：浏览器发现读取 ProgramFiles、ProgramFiles(x86)、ProgramW6432、LOCALAPPDATA，覆盖非 C 盘及按用户安装；数据目录使用目标平台的路径规则，Windows 缺少 LOCALAPPDATA 时回退到用户 AppData/Local。保留直接启动 node.exe、隐藏后台窗口、独立日志和多客户端复用方案；Windows SAPI 与 gdigrab 原有实现保留。

新增 Windows PowerShell 安装命令、TOML 路径示例和 Windows 停服边界。新增 `.github/workflows/local-mcp.yml`，配置 Windows/macOS 实机执行的定向测试，但尚未提交、推送或触发远程 CI。

本机执行 `node --test --test-concurrency=1 tests/platform-paths.test.mjs tests/local-mcp.test.mjs tests/engine.test.mjs tests/design-export.test.mjs tests/motion-recording.test.mjs`：19 项中 17 通过、2 项 Windows 专属测试跳过、0 失败。最后路径字面量整理后单独重跑 platform-paths 的 3 项，均通过；`git diff --check` 通过。

Windows 路径覆盖属于平台参数模拟；Windows 后台进程、系统录屏、SAPI 和 Codex 的 Windows 客户端接入尚未在真实 Windows 主机验收，不以 Mac 测试或 CI 文件存在替代。
