import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { motionTemplates } from '../src/motion-libraries.mjs';
import { renderTemplate } from '../src/render-template.mjs';

const template = motionTemplates().find(item => item.id === 'mw-toy-flipbook');
test('custom seekable films resolve motion assets on the render server without app-port dependencies', { skip: !template, timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-motion-render-'));
  try {
    const htmlPath = join(directory, 'custom.html');
    await writeFile(htmlPath, `<!doctype html><html><head><base href="/vendor/motion-web/cases/toy-flipbook/"></head>
      <body style="margin:0;background:#e7d9c6"><img id="subject" alt="Toy" width="500">
      <script>
        const image=document.getElementById('subject'); image.src='img/f0.webp';
        window.__meta={dur:1,fps:12,w:1440,h:900};
        window.__seek=t=>{image.style.transform='translateX('+(100+t*200)+'px)';};
        image.decode().then(()=>{window.__ready=true;});
      </script></body></html>`);
    const result = await renderTemplate({ templateId: template.id, htmlPath, outputPath: join(directory, 'custom.mp4'), scale: 0.2 });
    assert.equal(result.duration, 1);
    assert.equal(result.fps, 12);
    assert.equal(result.deterministic, true);
    assert.deepEqual(result.missingAssets, []);
    assert.equal(result.qa.ok, true);
    await assert.rejects(renderTemplate({ templateId: template.id, htmlPath: template.entry, outputPath: join(directory, 'raw.mp4') }), /原始实时交互/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
