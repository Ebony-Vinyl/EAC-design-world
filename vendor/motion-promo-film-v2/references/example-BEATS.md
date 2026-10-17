# BEATS.md — 《Our Free Model》65s v4（悬浮窗口舞台版 + 原创配乐）

v4 变更（按用户反馈）：
① **悬浮居中窗口**——应用窗口 1560×960 × scale0.93（实际 1451×893）悬浮在 1920×1080 舞台中央，
   四周留边 + 底部光晕 + 三块旋转描边装饰；窗口随鼠标反向轻漂（±13px）产生悬浮视差。
② **节奏放慢**——分节从 10 段减到 8 段，每段 3.9~8.5s，所有交互结果停留 ≥1.2s；运镜放缓（缓动窗 0.62×段长）。
③ **光标零偏移**——CLICKS/镜头目标全部改为 DOM 实测锚点（measureAnchors，含窗口基准缩放），
   光标画在舞台层，用解析矩阵（窗口漂移 + 摄像机）算屏幕坐标；17 个点击点实测偏差 ≤2px。
④ **标语卡复刻参考片构图**——窗口不退场：切点处镜头右推、世界压暗 0.58×，大卡从右侧滑入压在窗口右半（卡1 时段聚合面板、卡2 时段路由链在左侧压暗可见）。
⑤ **原创配乐《Free Flight》**（audio.py 纯 numpy 合成）——A 小调 Am→F→C→G，
   92.3077 BPM（0.65s/拍，B0=0.116）与切点网格同源；结构：紧张钩子→标题落点→轻快→渐强→
   breakdown(钟琴动机)→降级冲击→breakdown2→build→LIVE 全奏 drop→anthem→淡出；
   响度弧线 rms 0.117→0.299；关键词逐拍上行钟琴（56.016+0.65i）。
⑥ **官方 logo**——用户提供的蓝发女仆 logo 用于：标题卡/结尾卡图标、插件设置头像、侧栏、安装完成卡。

## 分节表（切点全部在节拍网格 t=0.116+0.65k 上）

| # | 起~止 | 眉题 / 标题 | UI 动作 | 音乐 |
|---|-------|------------|---------|------|
| 钩子 | 0~4.016 | — DEEPSEEK HARNESS · 免费额度用尽时 / 十二个免费模型，一个一个去试？ | 输入→发送→思考→回复→429 芯片→镜头推近 1.62× | 紧张：低音脉冲+心跳+riser@3.15 |
| 标题卡 | 4.016~6.616 | （无字幕组） | 窗口失焦拉远 0.88×，logo+词牌绽放 | impact + pad 绽放 |
| 00 安装 | 6.616~13.766 | — 00 · ONE-CLICK INSTALL / 一键安装 | 插件页→添加插件→输入 dsh-our-free-model→pnpm 终端→已安装卡→立即启用→设置→OFM 导航 | 轻快 groove Am→F，clicks×5，ding@11.65 |
| 01 免费模型 | 13.766~19.616 | — 01 · ZERO SETUP / 免登录，免 Key | free tab→水位 58%→8 卡 pop→重新探测→绿光环 | mid：+拍手，16 分琶音 (F) |
| 02 白嫖 | 19.616~24.816 | — 02 · DAILY CLAIM / 签到，自动领取 | 白嫖 tab→4 卡→一键领取→+100 积分→翻已接入→3→4/13 | mid (C)，blip×2@22.6 |
| 03 聚合 | 24.816~30.016 | — 03 · BRING YOUR KEY / 聚合渠道，随接随用 | 聚合 tab→搜 "deep"→DeepInfra 获取 Key→输 Key→保存→已配置 1 家 | full (G)+16 分帽，riser@28.9 |
| 卡1 | 30.016~33.916 | 04 · TOKEN SAVER / 省 Token，从请求开始 | 窗口压暗保留，大卡右侧滑入，进度条 −67.4%/−34.3% | breakdown：pad+sub+钟琴动机 |
| 05 路由 | 33.916~39.116 | — 05 · FAILOVER / 一条链路，层层兜底 | 路由 tab→链路 4 行→37.2 降级演示(红→琥珀→绿)→推近 1.48× | full2 (Am)，impact+buzz@37.2，ding@38.1 |
| 卡2 | 39.116~43.016 | 06 · OBSERVABLE / 用了多少，一清二楚 | 窗口压暗保留，大卡右侧滑入：14.6K/100% 进度条卡 | breakdown 2 (C) |
| 07 网关 | 43.016~46.916 | — 07 · LOCAL GATEWAY / 一个本地网关 | 网关 tab→端点行→复制链接→已复制 | build：渐强+军鼓滚奏+riser@45.65 |
| 实测 | 46.916~55.366 | — 实测 · LIVE / 免费模型，直接开聊 | 空态→你好→Space Bunny 回复(14.6K tok·136 tok/s)→你能干什么→7 行回复 | **THE DROP**：全奏 Am→F→C→G |
| 结尾卡 | 55.366~63.166 | （无字幕组） | logo→词牌→关键词逐拍 ×5(56.016+0.65i)→CTA@59.3→脚注 | anthem：半拍鼓+动机+上行钟琴 |
| 淡出 | 63.166~65 | | | pad 收尾 fade |

## 时间轴常量
`CUTS=[0,4.016,6.616,13.766,19.616,24.816,30.016,33.916,39.116,43.016,46.916,55.366,63.166]`
`T_TITLE=4.016 T_INST=6.616 S1=13.766 S2=19.616 S3=24.816 C1=30.016 S4=33.916 C2=39.116 S5=43.016 T_LIVE=46.916 T_END=55.366 T_OUT=63.166 DUR=65`
CLICKS（18 个，全部锚点寻址）：1.72 7.75 8.55 9.85 12.45 13.6 14.2 17.9 19.8 22.4 25.0 25.6 27.6 28.95 34.1 44.9 49.35 53.55

## 关键实现
- 窗口：`#win` JS 每帧写 `translate(±13px 反向漂移) scale(0.93)`；光标屏幕坐标 = 窗口锚点+漂移，再过摄像机（world 原点 960,540）。
- 锚点：`ANCHOR_SEL` 25 项，`measureAnchors()` 在 fonts.ready 后、首个 render 前量（先置 win scale(0.93)，dlg-progress 临时切 done 形态量 btn-enable）。
- 摄像机：CAM 键支持 `{a:'锚点',dx,dy}` 启动时解析成绝对坐标。
- 配乐：audio.py 读 film.html 的 `const CUTS`/`const CLICKS`，合成 kick/sub/bass/hat/clap/snare/pluck/bell/pad/riser/impact，pad/bass 受 kick sidechain，母带 tanh×1.25 → peak .85，成片 loudnorm I=-17（实测 -15.6 LUFS）。

## 渲染管线
```
NODE_PATH="$(npm root -g)" node render.js --film film.html   # 1950 帧 → out/f_*.jpg
python audio.py                                              # 原创配乐 → audio_bed.wav
ffmpeg -y -framerate 30 -f image2 -c:v mjpeg -i out/f_%05d.jpg -i audio_bed.wav \
  -filter:a loudnorm=I=-17:TP=-1.5 -ar 48000 -c:v libx264 -crf 17 -preset medium \
  -pix_fmt yuv420p -movflags +faststart -shortest "Our Free Model 宣传片 65s.mp4"
```
