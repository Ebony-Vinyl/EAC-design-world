// 光标锚点精确度探针：验证「光标是否像素级落在点击目标中心」
// 用法：把本文件放到 film.html 同目录，NODE_PATH="$(npm root -g)" node probe.js
// 原理：逐时刻 seek 后，读光标 #cursor 的 computed translate（屏幕坐标），
//       与目标元素 getBoundingClientRect 中心对比；|delta|<=3px 为通过。
// 若大面积偏移，按 references/CURSOR-ANCHOR.md 的三个坑排查。
const { chromium } = require('playwright');
const { pathToFileURL } = require('url');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// [时刻, 目标选择器] —— 覆盖所有关键点击点（改 film 后同步更新）
const TESTS = [
  ['2.0',  '#chat1 .sendbtn'],
  ['7.9',  '#btn-addplugin'],
  ['9.85', '#btn-install'],
  ['12.45','#btn-enable'],
  ['13.6', '#nav-ofm'],
  ['14.3', '#tabchips .tchip[data-t="free"]'],
  ['17.9', '#btn-probe'],
  ['19.9', '#tabchips .tchip[data-t="baimo"]'],
  ['22.5', '#btn-claim'],
  ['25.1', '#tabchips .tchip[data-t="agg"]'],
  ['25.8', '#a-searchbox'],
  ['27.7', '#btn-getkey'],
  ['28.9', '#btn-savekey'],
  ['34.2', '#tabchips .tchip[data-t="route"]'],
  ['44.9', '#btn-copyep'],
  ['49.4', '#chat2 .sendbtn'],
  ['53.6', '#chat2 .sendbtn'],
];

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto(pathToFileURL('film.html').href);
  await p.waitForFunction('window.__ready === true');
  let worst = 0;
  for (const [t, sel] of TESTS) {
    await p.evaluate(tt => window.__seek(tt), parseFloat(t));
    const r = await p.evaluate(([tt, sel]) => {
      const br = document.querySelector(sel).getBoundingClientRect();
      const m = new DOMMatrix(getComputedStyle(document.getElementById('cursor')).transform);
      return [Math.round(br.left + br.width / 2), Math.round(br.top + br.height / 2), Math.round(m.m41), Math.round(m.m42)];
    }, [t, sel]);
    const dx = r[2] - r[0], dy = r[3] - r[1];
    worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
    console.log(`${Math.abs(dx) <= 3 && Math.abs(dy) <= 3 ? '✓' : '✗'} t=${t} ${sel} delta=(${dx},${dy})`);
  }
  console.log('worst |delta| =', worst, 'px');
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
