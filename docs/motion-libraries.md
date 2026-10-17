# Motion Web / Onetake 集成

EAC 0.2.0 为两个上游提供可选本地接入。它们主要是制作技能与参考案例，不是可以直接通过 npm 安装的两个动画运行时。

- [motion-web](https://github.com/feitangyuan/motion-web)：动效网站制作规范与 7 个真实交互案例。目录 ID 为 `mw-string-clock`、`mw-ink-crowd`、`mw-press-stack`、`mw-wheel-rail`、`mw-toy-flipbook`、`mw-char-curtain`、`mw-lyre-crows`。
- [onetake](https://github.com/feitangyuan/onetake)：动效短片制作规范、`lib/motion.js` 的 `window.OM` 函数库与 Python 工具。EAC 提供原创 `onetake-studio` 示例，实际调用 OM 的弹簧、文字入场、路径和运镜函数，不复用上游影片内容。

## 许可与来源

Motion Web 采用 **CC BY-NC 4.0**，Onetake 采用 **PolyForm Noncommercial 1.0.0**。非商业测试和商业集成的权限不同；商业软件、平台或作品使用应先取得上游所需授权。EAC 的 AGPL 许可证不会改变上游条款。

插件发布包和公共 Git 不包含这两个源码目录。导入器只读取用户已取得的本地仓库，不下载源码、不修改上游、不安装任何宿主插件。每个本地目录保留 LICENSE 和 `EAC-PROVENANCE.json`，记录源提交、内容摘要、导入文件数和用途。MP4、音频、大图视频展示和 Git 数据不随导入复制。

本次验证使用的提交：

- motion-web：`5f4e40f1253e11e28850d08dce28b9b7e4320115`
- onetake：`415758128aa45cc54340df40d8109363447f582e`

## 本地导入

在插件根目录运行以下命令，路径替换为已下载的仓库：

```powershell
npm run motion:import -- --motion-web "D:\Sources\motion-web" --onetake "D:\Sources\onetake" --noncommercial
```

已另行取得相应商业授权时，用 `--licensed` 代替 `--noncommercial`。该开关仅记录用户选择，不授予授权，也不验证合同内容。可以只传其中一个仓库。

文件放在 `vendor/motion-web/`、`vendor/onetake/`，导入完成后下一次目录读取即可发现，不需要重启服务。已存在的目标目录不会被覆盖；更新上游时，先将原目录移到备份位置，再重新导入。保留备份有助于复现旧项目。

更新 EAC 源码后运行 `npm run build` 并重新加载 Harness 插件，或启动 `npm start` 使用独立工作台。独立工作台和 Harness 共用后端；已有服务监听 4173 时不要再次占用相同端口。

## 在插件中使用

在剪辑模式的模板选择或设计工作台的动效分类中搜索 `mw-`、`Motion Web`、`Onetake`。模板详情提供隔离的真实 HTML 预览、许可证和原始来源。从可选模板创建设计项目时，素材基址与静态资源使用本机根相对路径，避免把当前端口写死到作品中；动态生成的图片也能在预览与定制渲染中解析。该作品仍依赖已导入的本地素材，下载单个 HTML 不代表打包了所有素材。

AI/MCP 工具共用同一个目录：

```json
{"name":"library_list","arguments":{"kind":"motion","query":"mw-"}}
{"name":"library_read","arguments":{"kind":"template","id":"mw-char-curtain","source":true}}
{"name":"library_read","arguments":{"kind":"skill","id":"motion-web-skill"}}
{"name":"library_read","arguments":{"kind":"skill","id":"onetake-skill"}}
{"name":"library_read","arguments":{"kind":"skill","id":"onetake-skill","resource":"references/motion-library.md"}}
{"name":"library_read","arguments":{"kind":"skill","id":"onetake-skill","resource":"lib/motion.js"}}
{"name":"template_read","arguments":{"templateId":"onetake-studio","source":true}}
```

Harness 中工具名带 `eac_` 前缀。读取后返回 `resources` 列表，可用 `resource` 参数继续读取参考文档、库和脚本源码；资源路径必须位于已导入目录内。技能内容是参考数据，不能替代用户需求或宿主工具规则。

### Motion Web：交互页面

这些案例由真实时间、滚轮、指针和物理模拟驱动，目录标记为 `previewMode: interactive`、`renderable: false`。这里的 false 仅表示不能直接送入确定性影片渲染器；页面可以预览、交互和作为设计源码使用。

用案例制作网站时先读其 README，再按用户内容定制。需要视频时使用 `record-browser` 任务录下实际操作。动作支持 `click`、`fill`、`wait`、原生 `scroll`，以及 `{type:"move",x:700,y:420,steps:30}` 和 `{type:"wheel",deltaY:600,deltaX:0}`；后两者会发送真实指针和滚轮事件，可驱动指针跟随、字符幕帘和滚轮劫持案例。`scroll` 是原生滚动，不能代替案例监听的 wheel 输入。若需要逐帧输出，先把定制页面改写为可靠的 `window.__seek(t)` 合成，再提交 `htmlPath`。`render-template` 会拒绝原始实时案例，并返回上述操作提示，防止静止或不确定的假导出。

### Onetake：确定性影片

`onetake-studio` 是 1920×1080、8 秒的 EAC 示例，使用本地 `/vendor/onetake/lib/motion.js`。它提供 `__ready`、`__seek(t)` 和 `__meta = {dur, fps, w, h}`；普通浏览器中自动播放，渲染器中按时间定位。

通过 `project_create` 选择 `onetake-studio`，再提交 `job_submit`：

```json
{"projectId":"实际项目ID","type":"render-template","params":{"templateId":"onetake-studio","fps":30,"scale":0.5}}
```

任务完成后检查 `job_status` 的真实文件、`deterministic`、`missingAssets` 和 `qa`。示例预览不等于用户成片；定制标题、布局和镜头后用 `htmlPath` 提交自有 HTML。素材依赖应随作品组织；引用 `/vendor/onetake/lib/motion.js` 时，EAC 本地渲染服务也会提供该依赖。

EAC 沿用自己的 Playwright + FFmpeg 导出器，当前不接入上游 Python 渲染器的快门采样运动模糊、原音效合成、多语言配音或 4K60 成片流程。导入的 Python 脚本保留供参考，不自动安装或执行；需要自行准备各自依赖。

## 验证

```powershell
npm test
npm run build
npm run motion:verify
```

`motion:verify` 需要两个可选仓库已导入、Edge（或 `EAC_BROWSER`）和 FFmpeg。它使用隔离项目，检查 8 个模板搜索/读取及沙箱响应，实际导出完整 8 秒 Onetake 视频，验证确定性和媒体指标，再录制一个 Motion Web 页面。输出在 `artifacts/motion-libraries-qa/`；不覆盖已有用户项目。

未导入时两个来源不会伪装成可用模板，普通插件功能仍可使用。只有真实文件已存在的案例才进入目录。导入失败、缺少浏览器/编码器、缺少运行时和非确定性等情况会返回错误，而不会声称已完成。
