# CURSOR-ANCHOR.md — 锚点光标系统（零偏移的关键）

用户验收的硬标准：**光标必须像素级落在点击目标中心**。手填坐标必然漂移（窗口缩放/面板位移/字体加载都会改布局），唯一可靠做法是启动时实测 DOM。

## 1. 锚点测量（启动时一次）

```js
const ANCHOR_SEL = {
  send1:'#chat1 .sendbtn', addbtn:'#btn-addplugin', dlginp:'#inst-dialog .dlginp',
  installbtn:'#btn-install', enablebtn:'#btn-enable', navofm:'#nav-ofm',
  tabfree:'#tabchips .tchip[data-t="free"]', /* 其余 tab 同理 */
  probe:'#btn-probe', claim:'#btn-claim', searchbox:'#a-searchbox',
  getkey:'#btn-getkey', savekey:'#btn-savekey', copyep:'#btn-copyep',
  input2:'#chat2 .inputbar', send2:'#chat2 .sendbtn',
  fail429:'#h-fail', dlg:'#inst-dialog', chain:'#r-chain', ep:'#g-ep', fgrid:'#f-grid',
};
const A = {};
function measureAnchors(){
  /* 关键：先把窗口基准缩放写上，量出来的才是运行态世界坐标 */
  win.style.transform = 'scale(0.93)';
  for(const k in ANCHOR_SEL){
    const el = document.querySelector(ANCHOR_SEL[k]);
    if(!el){ console.warn('anchor missing:', k); continue; }
    const r = el.getBoundingClientRect();          // world 尚未变换，rect 即世界坐标
    A[k] = [r.left + r.width/2, r.top + r.height/2];
  }
  /* display:none 里的元素（如弹窗完成态的按钮）临时切换形态再量一次 */
  const form = $('dlg-form'), prog = $('dlg-progress');
  form.style.display='none'; prog.style.display='block';
  const en = document.querySelector('#btn-enable').getBoundingClientRect();
  A.enablebtn = [en.left + en.width/2, en.top + en.height/2];
  form.style.display=''; prog.style.display='none';
}
```

**时机**：`fonts.ready` 之后（字体影响 flex 行宽）、首次 `render()` 之前。boot 顺序：
`await document.fonts.ready → measureAnchors() → resolveCam() → resolveCpath() → render(0/1/10) → window.__ready=true`。

**为什么 rect 就是世界坐标**：测量时 `#world` 尚无 JS transform（identity），`#stage` 在 (0,0) 铺满 1920×1080，所以 client 坐标 = world 坐标。窗口的 CSS/JS 基准缩放 `scale(0.93)` 必须此时已在 `#win` 上，量出的锚点才含它。

## 2. 光标屏幕坐标（解析式，含三层变换）

光标放在 **stage 层**（不在 `#world` 里），每帧直接写屏幕坐标：

```js
/* cp = cursorAt(t)：锚点世界坐标（已含窗口基准缩放 0.93） */
const px = cp[0] + wdx, py = cp[1] + wdy;          // 加窗口漂移（窗口动，内容跟着动）
const sx = (960-cx) + 960 + c.s*(px-960);          // 过摄像机；world origin=(960,540) 的 +960/+540 项！
const sy = (540-cy) + 540 + c.s*(py-540);
const k  = 1/(c.s*0.93);                            // 光标视觉缩放
cur.style.transform = `translate(${sx}px,${sy}px)`; // 只 translate
ring.style.transform  = `translate(-50%,-50%) scale(${mix(.32,1.5,pulse)*k})`;   // 缩放在子元素上
cur.querySelector('.c').style.transform = `translate(-50%,-50%) scale(${(1-press*.3)*k})`;
```

`wdx/wdy` 与窗口 transform 用的是**同一个**值：
```js
const wdx = -clamp(cd[0],-40,40)*0.32, wdy = -clamp(cd[1],-30,30)*0.32;
win.style.transform = `translate(${wdx}px,${wdy}px) scale(0.93)`;
```

## 3. 三个致命坑（全部真实踩过，偏差 40~1000px）

| 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|
| **重复缩放** | 全部点击点系统性偏几十~几百 px | 锚点已是缩放后坐标，公式里又乘了一次 0.93 | `px = cp[0] + wdx`，不再乘 |
| **漏 transform-origin** | 偏差随 s 增大而增大 | `#world` 默认 origin=(960,540)，映射是 `O + T + s(p-O)`，写成 `T + s·p` 就漏了原点项 | 屏幕公式保留 `+960/+540` |
| **父级 scale 偏心** | 光标差半个光标尺寸（~8px） | 父级 `scale(k)` 把子元素 `translate(-50%,-50%)` 也缩了 | 缩放写在子元素自己的 transform 里 |

调试方法：探针里同时导出 `world 的 computed matrix`、`win 的 computed matrix`、`cursorAt(t)` 原始值，手算一遍看哪个环节对不上。注意 Chrome 的 `getComputedStyle().transform` **不含** transform-origin 的折入，手算时必须自己加 `o·(1-s)` 项。

## 4. 光标路径与清脆手感

```js
const CPATH_RAW = [
  [1.15,'send1'], [2.25,'send1'],       // 相同目标 = 停留
  [2.4,1250,960],                        // 数字 = 直接世界坐标（无对应元素时）
  [6.85,'addbtn'], [8.05,'addbtn'],
  [8.3,'dlginp',0,0],                    // [t, 锚点, dx, dy]
  /* ... */
];
/* 启动后物化：字符串锚点 → 坐标 */
CPATH = CPATH_RAW.map(r => typeof r[1]==='number' ? r
  : [r[0], A[r[1]][0]+(r[2]||0), A[r[1]][1]+(r[3]||0)]);

/* 段内插值：前 58% 用 outQuint 甩到位，余下停在目标（清脆不拖沓） */
const k = E.outQuint(clamp((t-a[0])/(span*0.58), 0, 1));
```

**点击反馈**：`CLICKS=[...]` 数组；按压 `sin(π·p)` 脉冲缩放 0.7 倍、扩散环 0.34s。
**落点时刻**（供音频"滴答"）：`settle_j = t_{j-1} + 0.58·(t_j − t_{j-1})`，跳过同目标停留段、跳过光标隐藏时段、跳过紧贴 click（<0.12s）的点，导出为 `const TICKS=[...]`。

**光标隐藏窗口**：片头标题卡、标语卡时段、结尾卡期间隐藏；写成时刻区间的并集：
```js
const cv = (t>=1.05&&t<3.95)||(t>=6.75&&t<29.9)||(t>=33.95&&t<39.05)||(t>=43.05&&t<55.15);
```

## 5. 验证（probe.js）

改完 film.html **必跑** `node probe.js`：17 个点击点逐个 seek 后对比光标 computed translate 与目标 `getBoundingClientRect` 中心，要求全部 |delta|≤3px。有任何 ✗ 按第 3 节三坑排查，禁止"看起来差不多"就全量渲染。
