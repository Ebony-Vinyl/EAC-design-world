# 工作台审查修复

## 数据目录单写入者

引擎在初始化项目状态之前，通过 proper-lockfile 对真实数据目录取得进程间锁。不同端口、不同启动入口使用同一目录时，第二个引擎会明确失败，不再把第一进程的任务误判为中断或覆盖项目。正常关闭和初始化失败均释放锁，重复关闭保持幂等，关闭后的引擎拒绝新的写入。

锁使用原子目录创建与心跳，15 秒更新、120 秒失效恢复。异常退出后最多等待约 2 分钟再重试；不要手动删除仍由活跃进程持有的 `.writer.lock`。这项保护要求所有写入者运行新版：升级前应先关闭使用该目录的旧服务。锁实现及其依赖随更新包以 `vendor/eac-runtime/proper-lockfile.cjs` 独立捆绑，已有安装保留原 `node_modules` 也能正常加载；从源码安装仍使用 `npm ci`。

## 预览隔离与版本

后端预览与编辑器 srcDoc 使用同一 CSP 策略：允许内联脚本及当前工作台来源的静态资源，禁止 fetch 等连接、表单和未允许的资源来源。编辑器在文档最前面的 head 中插入策略，同时保留不透明来源 iframe sandbox。设计幻灯片拆页也使用同一策略。此修改不赋予模板访问父页面的权限。

画布的 HTML iframe 和 SVG 图片地址包含修订号，HTML iframe 按文件 ID 和修订号重新挂载。自动轮询或手动刷新后，版本标签与实际预览一致。

## 本地升级

签名本地更新与远程更新都检查 minSupported；低于最低支持版本时，在暂存和替换安装文件之前拒绝更新。满足最低版本的正常安装仍可执行。

## 发布媒体输入

媒体来源和发布输出目录分离。默认媒体缓存：

```text
release/media-cache/eac-design-world-v0.3.0-media.zip
```

可显式指定已下载的同一发布媒体包：

```sh
npm run release:prepare -- --media /absolute/path/to/eac-design-world-v0.3.0-media.zip
npm run release:prepare -- --output release/new-package --media /absolute/path/to/media.zip
```

也支持 EAC_RELEASE_MEDIA。现有位置参数形式的输出目录仍兼容。媒体文件必须匹配固定的官方发布 SHA-256；来源检查在创建输出目录之前完成。未自动下载媒体，也没有执行真实签名发布。

## 回归测试

- data-lock：跨进程拒绝第二写入者、关闭后恢复、初始化失败释放、重复关闭与关闭后拒绝写入。
- workspace-review：浏览器中执行脚本，验证外联被阻止、本地图片仍可加载、幻灯片拆页隔离、HTML 和 SVG 修订刷新。
- maintenance-updater：有效签名包的最低版本拒绝和允许路径，并验证拒绝时原文件不变。
- release-inputs：默认来源与输出独立、显式路径、缺失及篡改媒体在创建输出前失败。

这些测试已加入本地 MCP 的 Windows/macOS CI；远端结果需在提交后单独验证。

## 上游适配阶段的历史验证（2026-10-25）

以下记录保留上游审查阶段的结果；v0.6.0 的完整回归、跨平台 CI、实际签名升级和回滚结果以本版发布说明及 release-manifest.json 为准。

- `npm run build` 和 `git diff --check` 通过。
- 最终定向回归：56 项，55 通过、1 项 Windows SAPI 跳过、0 失败。包括目录锁、发布输入、真实浏览器预览、维护更新，以及既有 MCP/媒体/导出流程。
- 修复后的全量回归：227 项，211 通过、4 失败、12 跳过；四项仍为审查前已确认的缺失 OpenDesign 文件、未安装可选 Motion Web 库和两个依赖本地 Whisper 模型的测试。随后对 localhost 同端口资源别名做小幅调整并新增一项测试，以上最终定向回归已覆盖该变更；未再次重复全量回归。
- 正常重启空闲的本地独立服务后，项目和任务记录与重启前逐项一致。
- 尚未执行本修复分支的远端 Windows/macOS CI，也没有实际签名发布包。
