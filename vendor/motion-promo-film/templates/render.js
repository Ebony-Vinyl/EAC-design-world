// 逐帧抓帧：node render.js [--film my-film.html] [--smoke]
// 依赖：全局 playwright（NODE_PATH 指到全局 node_modules）+ 本机 Edge
// 读取页面里的 window.__FPS / window.__DUR / window.__seek / window.__ready
const { chromium } = require('playwright');
const { pathToFileURL } = require('url');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const film = args.includes('--film') ? args[args.indexOf('--film') + 1] : 'film.html';
const SMOKE = args.includes('--smoke');
const SMOKE_N = 29;

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto(pathToFileURL(film).href);
  await p.waitForFunction('window.__ready === true', { timeout: 30000 });

  const { fps, dur } = await p.evaluate(() => ({ fps: window.__FPS, dur: window.__DUR }));
  const N = Math.round(fps * dur);

  if (SMOKE) {
    fs.mkdirSync('smoke', { recursive: true });
    let i = 0;
    for (let k = 0; k < SMOKE_N; k++) {
      const t = Math.min(dur - 0.05, (k / SMOKE_N) * dur + 0.05);
      await p.evaluate(tt => window.__seek(tt), t);
      await p.screenshot({ path: `smoke/s_${String(i++).padStart(2, '0')}_t${t.toFixed(1)}.png` });
    }
    console.log('smoke done:', SMOKE_N, 'frames — 逐张查看后再全量渲染');
  } else {
    fs.mkdirSync('out', { recursive: true });
    for (let i = 0; i < N; i++) {
      const t = i / fps;
      await p.evaluate(tt => window.__seek(tt), t);
      // 注意：扩展名决定 ffmpeg 侧的探测（PITFALLS §6）；此处保存为 .jpg
      await p.screenshot({ path: `out/f_${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 95 });
      if (i % 150 === 0) console.log('frame', i, '/', N);
    }
    console.log('render done:', N, 'frames');
  }
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
