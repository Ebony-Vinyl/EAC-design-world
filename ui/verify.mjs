import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { composeMusic, remapTranscriptToTimeline, renderTimeline, synthesizeVoice } from '../src/media/index.mjs';
import { outputPaths, resultWarnings } from './api.js';

const directory = await mkdtemp(join(tmpdir(), 'eac-ui-'));
const engine = await createEngine({ dataDir: directory });
const checks = [];
const pageErrors = [];
let app;
let browser;
let page;
const record = message => { checks.push(message); console.log(`PASS ${message}`); };

async function ffmpeg(args) {
  return new Promise((accept, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { windowsHide: true });
    const chunks = [];
    let error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-65536); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? accept(Buffer.concat(chunks)) : reject(new Error(error || `FFmpeg exited with ${code}`));
    });
  });
}

async function request(path, body, method = 'POST') {
  const response = await fetch(`${app.url}/api${path}`, body === undefined ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
}

async function finish(id, expected = 'completed') {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const job = await request(`/jobs/${id}`);
    if (!['queued', 'running'].includes(job.status)) {
      assert.equal(job.status, expected, job.error);
      return job;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function submit(type, button) {
  const response = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url() === `${app.url}/api/jobs` && response.request().postDataJSON().type === type);
  await page.getByRole('button', { name: button, exact: true }).click();
  const received = await response;
  assert.equal(received.status(), 202);
  return { job: await received.json(), body: received.request().postDataJSON() };
}

async function navigate(label) {
  await page.locator('.app-topnav').getByRole('button', { name: label, exact: true }).click();
}

async function workflow() {
  await navigate('制作流程');
  await page.getByRole('heading', { name: '口播转录与初剪' }).waitFor();
}

async function noLegacyUI(target = page) {
  assert.doesNotMatch(await target.locator('body').textContent(), /concat|原生.*编辑器|语义分析/i);
  assert.equal(await target.locator('input[type="password"]').count(), 0);
}

async function noOverflow(label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      width, scroll: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll('.main-content button, [role="dialog"] button')].filter(button => {
        const rect = button.getBoundingClientRect();
        return rect.width && (rect.left < -1 || rect.right > width + 1 || button.scrollWidth > button.clientWidth + 2);
      }).map(button => button.textContent),
    };
  });
  assert.ok(result.scroll <= result.width + 1, `${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.controls, [], `${label}: overflowing controls`);
}

try {
  assert.ok(existsSync(new URL('../dist/index.html', import.meta.url)), 'Run npm run build first.');
  app = await startServer({ engine, port: 0 });
  assert.ok(app.port > 0);
  assert.notEqual(app.port, 4173);
  record('temporary port:0 server serves the actual production build and API');
  const executablePath = [process.env.EAC_BROWSER, chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(app.url);
  await workflow();
  assert.equal(await page.getByRole('button', { name: '转录字幕', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '生成时间线字幕', exact: true }).isDisabled(), true);
  await noLegacyUI();
  record('empty project disables transcription and timeline captions; removed editor UI is absent');

  const voice = join(directory, 'spoken English.wav');
  const source = join(directory, 'spoken video.mp4');
  const silent = join(directory, 'silent video.mp4');
  const music = join(directory, 'user music.wav');
  await synthesizeVoice({ outputPath: voice, text: 'Welcome to the editing studio. We review every caption and save the finished project.' });
  await composeMusic({ outputPath: music, duration: 4, bpm: 112, seed: 'eac-ui-check' });
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12', '-i', voice,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  let project = await request('/projects', { title: 'UI verification', brief: 'Actual temporary media', width: 160, height: 90, fps: 12 });
  for (const path of [silent, source, voice, music]) project = await request(`/projects/${project.id}/assets`, { path });
  const audioAsset = project.assets.find(asset => asset.path === voice);
  const videoAsset = project.assets.find(asset => asset.path === source);
  const musicAsset = project.assets.find(asset => asset.path === music);
  await page.reload();
  await workflow();
  const speech = page.getByLabel('口播素材', { exact: true });
  await page.waitForFunction(() => document.querySelectorAll('.speech-controls label:first-child select option').length === 3);
  assert.equal(await speech.locator('option').count(), 3);
  assert.ok(!(await speech.locator('option').allTextContents()).includes('silent video.mp4'));
  await speech.selectOption(audioAsset.id);
  assert.equal(await page.getByRole('button', { name: '生成口播初剪', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '生成时间线字幕', exact: true }).isDisabled(), true);
  await page.getByLabel('语音语言', { exact: true }).selectOption('en');
  record('speech picker excludes silent video; audio permits transcription and disables video rough cut');

  const state = await request('/state');
  assert.equal(state.capabilities.find(item => item.id === 'transcription')?.available, true, 'Local ASR must be installed.');
  const transcribe = await submit('transcribe', '转录字幕');
  assert.deepEqual(transcribe.body.params, { assetId: audioAsset.id, language: 'en' });
  const transcriptJob = await finish(transcribe.job.id);
  assert.ok(transcriptJob.result.segments.length > 0);
  assert.ok(transcriptJob.result.segments.some(segment => segment.words?.length > 0));
  await page.getByRole('button', { name: '查看 SRT', exact: true }).click();
  await page.locator('.subtitle-text').waitFor();
  const actualSrt = await readFile(transcriptJob.result.srtPath, 'utf8');
  assert.match(actualSrt, /-->/);
  assert.equal(await page.locator('.subtitle-text').textContent(), actualSrt);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 SRT', exact: true }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /\.srt$/);
  assert.equal(await readFile(await download.path(), 'utf8'), actualSrt);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('real word-aligned ASR submits asset/language; displayed and downloaded SRT match the file byte for byte');

  await speech.selectOption(videoAsset.id);
  const roughCut = await submit('rough-cut', '生成口播初剪');
  assert.deepEqual(roughCut.body.params, { assetId: videoAsset.id, language: 'en' });
  await finish(roughCut.job.id);
  await page.getByText('请人工复核转录文字、保留片段与成片。', { exact: true }).waitFor();
  project = await request(`/projects/${project.id}`);
  assert.ok(project.clips.length > 0);
  assert.ok(project.clips.every(clip => clip.assetId === videoAsset.id));
  record('real rough cut changes the timeline and displays the human-review warning');

  // Remove the temporary timeline to exercise a real caption failure without a response fixture.
  const clips = structuredClone(project.clips);
  await engine.store.updateProject(project.id, value => { value.clips = []; });
  const invalidCaptions = await request('/jobs', { type: 'captions', projectId: project.id, params: { assetId: videoAsset.id } });
  const failedCaptions = await finish(invalidCaptions.id, 'failed');
  assert.ok(failedCaptions.error);
  await page.locator('.workflow-main').getByRole('alert').filter({ hasText: failedCaptions.error }).waitFor();
  await engine.store.updateProject(project.id, value => { value.clips = clips; });
  await page.reload();
  await workflow();
  await speech.selectOption(videoAsset.id);
  record('actual caption mapping failure is visible in the workflow');

  const captions = await submit('captions', '生成时间线字幕');
  assert.deepEqual(captions.body.params, { assetId: videoAsset.id });
  const captionJob = await finish(captions.job.id);
  project = await request(`/projects/${project.id}`);
  const transcript = project.assets.find(asset => asset.id === videoAsset.id).transcript;
  assert.deepEqual(project.captions, remapTranscriptToTimeline({ segments: transcript.segments, clips: project.clips, assetId: videoAsset.id }));
  assert.ok(project.captions.length > 0);
  assert.equal(captionJob.result.count, project.captions.length);
  await page.getByText(`时间线字幕：${project.captions.length} 段`, { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '生成时间线字幕' && !button.disabled));
  await page.getByText('查看时间线字幕', { exact: true }).click();
  assert.deepEqual(await page.locator('.timeline-caption-output li>span').allTextContents(), project.captions.map(caption => caption.text));
  await speech.selectOption(audioAsset.id);
  assert.equal(await page.getByRole('button', { name: '生成时间线字幕', exact: true }).isDisabled(), true);
  await speech.selectOption(videoAsset.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('mapped captions mobile');
  await page.screenshot({ path: join(directory, 'captions-mapped-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  record('captions submits only selected assetId, maps the rough-cut transcript, displays count/text, and rejects an unused source');

  const render = await submit('render', '渲染项目');
  const rendered = await finish(render.job.id);
  assert.equal(rendered.result.qa.ok, true);
  assert.ok((await readFile(rendered.result.path)).length > 1000);
  assert.equal(rendered.result.review.sampleCount, 12);
  assert.equal(rendered.result.review.columns, 4);
  assert.equal(rendered.result.review.rows, 3);
  assert.ok(outputPaths(rendered.result).includes(rendered.result.review.path));
  assert.ok((await readFile(rendered.result.review.path)).length > 1000);
  const baseline = join(directory, 'without subtitles.mp4');
  await renderTimeline({ project: { ...project, quality: state.settings.quality, captions: [] }, outputPath: baseline });
  const cue = project.captions.find(caption => caption.end - caption.start > 0.2);
  assert.ok(cue, 'A visible caption interval is required.');
  const frame = path => ffmpeg(['-i', path, '-ss', String((cue.start + cue.end) / 2), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const captionedFrame = await frame(rendered.result.path);
  const plainFrame = await frame(baseline);
  assert.equal(captionedFrame.length, 160 * 90 * 3);
  assert.equal(plainFrame.length, captionedFrame.length);
  let changed = 0;
  for (let index = 160 * 45 * 3; index < plainFrame.length; index += 3) {
    if (captionedFrame.subarray(index, index + 3).some((value, channel) => Math.abs(value - plainFrame[index + channel]) > 40)) changed++;
  }
  assert.ok(changed > 20, `Visible caption pixels: ${changed}`);
  await navigate('制作工作台');
  await page.getByRole('button', { name: '项目成片', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.preview-stage video')?.readyState >= 2);
  assert.equal(new URL(await page.locator('.preview-stage video').getAttribute('src'), app.url).searchParams.get('path'), rendered.result.path);
  await page.locator('.preview-stage video').evaluate((video, seconds) => new Promise(resolve => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = seconds;
  }), (cue.start + cue.end) / 2);
  await page.locator('.preview-stage video').evaluate(video => video.play());
  await page.waitForFunction(seconds => {
    const video = document.querySelector('.preview-stage video');
    return video?.readyState >= 3 && video.currentTime > seconds + 0.1;
  }, (cue.start + cue.end) / 2);
  await page.locator('.preview-stage video').evaluate(video => video.pause());
  await noLegacyUI();
  await page.screenshot({ path: join(directory, 'studio-captioned.png'), fullPage: true, animations: 'disabled' });
  await workflow();
  record(`real render produces a playable captioned video; ${changed} lower-frame pixels differ from caption-free output`);

  await page.getByLabel('分析素材', { exact: true }).selectOption(musicAsset.id);
  const analysis = await submit('analyze', '分析素材');
  assert.deepEqual(analysis.body.params, { assetId: musicAsset.id });
  await finish(analysis.job.id);
  const beats = await submit('beats', '分析节拍');
  assert.deepEqual(beats.body.params, { assetId: musicAsset.id });
  await finish(beats.job.id);
  await page.locator('.beat-result').waitFor();
  assert.match(await page.locator('.beat-result').textContent(), /BPM/);
  record('actual media and beat analysis submit selected assetId, with no fabricated semantic-analysis claim');

  await page.getByLabel('目标时长 / 秒', { exact: true }).fill('30');
  await page.getByRole('button', { name: '生成制作计划', exact: true }).click();
  await page.getByText('源素材不足目标时长，未自动复制或补造镜头', { exact: true }).waitFor();
  await page.getByLabel('目标时长 / 秒', { exact: true }).fill('1.5');
  await page.getByLabel('用户配乐路径', { exact: false }).fill(`  ${music}  `);
  const produce = await submit('produce', '开始完整制作');
  assert.equal(produce.body.params.musicPath, music);
  assert.equal(produce.body.params.duration, 1.5);
  assert.equal(Object.hasOwn(produce.body.params, 'bpm'), false);
  const produced = await finish(produce.job.id);
  assert.ok(produced.result.steps.some(step => step.type === 'beats'));
  assert.ok(!produced.result.steps.some(step => step.type === 'compose'));
  assert.equal(produced.result.qa.ok, true);
  assert.ok(outputPaths(produced.result).includes(produced.result.review.path));
  assert.ok((await readFile(produced.result.path)).length > 1000);
  await page.getByText('Black video detected', { exact: true }).waitFor();
  project = await request(`/projects/${project.id}`);
  assert.equal(project.musicPath, music);
  record('actual source-shortage warning, trimmed custom music, measured tempo and production output/QA pass');

  await noLegacyUI();
  await noOverflow('desktop');
  await page.screenshot({ path: join(directory, 'workflow-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('mobile 390px');
  await page.getByRole('button', { name: '查看 SRT', exact: true }).click();
  await page.locator('.subtitle-text').waitFor();
  await page.screenshot({ path: join(directory, 'srt-mobile.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: join(directory, 'workflow-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow('mobile 320px');
  record('desktop, 390px and 320px controls fit; mobile SRT dialog works');

  await navigate('任务队列');
  await page.locator('.job-info').getByText('语音转录', { exact: true }).waitFor();
  await page.locator('.job-info').getByText('口播初剪', { exact: true }).waitFor();
  await page.getByText(`已生成 ${captionJob.result.count} 段时间线字幕`, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '查看 SRT', exact: true }).count(), 2);
  await noLegacyUI();
  await noOverflow('mobile job queue');
  record('job queue shows real captions success/failure, readable job labels, SRT and output controls');
  await navigate('素材与输出');
  const subtitleRow = page.locator('.file-row').filter({ hasText: /\.srt/ }).first();
  await subtitleRow.getByRole('button', { name: '预览文件', exact: true }).click();
  await page.locator('.subtitle-text').waitFor();
  assert.match(await page.locator('.subtitle-text').textContent(), /-->/);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await noLegacyUI();
  record('actual SRT and rendered files appear in project outputs');
  const reviewRow = page.locator('.file-row').filter({ hasText: rendered.result.review.path });
  await reviewRow.getByRole('button', { name: '预览文件', exact: true }).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.file-preview img');
    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  });
  assert.equal(new URL(await page.locator('.file-preview img').getAttribute('src'), app.url).searchParams.get('path'), rendered.result.review.path);
  await noOverflow('mobile contact sheet preview');
  await page.screenshot({ path: join(directory, 'review-sheet-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('render/produce review.path outputs include actual 12-frame 4x3 contact sheets; real image preview loads');

  const subtitleRequest = url => url.pathname === '/api/files' && url.searchParams.get('path')?.endsWith('.srt');
  await page.route(subtitleRequest, route => route.fulfill({ status: 403, body: 'Forbidden' }));
  await subtitleRow.getByRole('button', { name: '预览文件', exact: true }).click();
  await page.getByText('字幕读取失败（403）', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute(subtitleRequest);
  await page.route(subtitleRequest, route => route.fulfill({ status: 200, body: '' }));
  await subtitleRow.getByRole('button', { name: '预览文件', exact: true }).click();
  await page.getByText('未识别到语音，SRT 文件为空。', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute(subtitleRequest);
  record('explicit SRT-only response fixtures cover read errors and empty content');

  await page.locator('.app-topnav').getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.locator('.settings-form input').count(), 2);
  assert.equal(await page.locator('.settings-form select').count(), 1);
  await page.getByLabel('默认画质', { exact: true }).selectOption('production');
  const settingsResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/settings'));
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const savedSettings = await settingsResponse;
  assert.equal(savedSettings.status(), 200);
  assert.deepEqual(Object.keys(savedSettings.request().postDataJSON()).sort(), ['outputRoot', 'quality', 'ttsVoice']);
  await noLegacyUI();
  await noOverflow('mobile settings');
  record('settings show and submit only output directory, quality and TTS');

  const picker = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    picker.setDefaultTimeout(20000);
    picker.on('pageerror', error => pageErrors.push(error.message));
    await picker.addInitScript(() => window.addEventListener('message', event => { window.selectedTemplate = event.data; }));
    await picker.goto(`${app.url}/?view=templates`);
    await picker.locator('.library-card').first().waitFor();
    const template = state.templates.find(item => item.id === '02-line-art');
    assert.ok(template);
    await picker.getByRole('button', { name: `选择${template.name}`, exact: true }).click();
    await picker.waitForFunction(() => window.selectedTemplate?.type === 'eac:template');
    assert.equal(await picker.evaluate(() => window.selectedTemplate.templateId), '02-line-art');
    await picker.getByLabel('搜索模板', { exact: true }).fill(template.id);
    assert.equal(await picker.locator('.library-card').count(), 1);
    await picker.waitForFunction(() => document.querySelector('.library-cover')?.naturalWidth > 0);
    await noLegacyUI(picker);
    await picker.screenshot({ path: join(directory, 'template-picker.png'), fullPage: true });
  } finally { await picker.close(); }
  record('template picker retains real thumbnails, filtering and eac:template selection messages');

  assert.ok(outputPaths(transcriptJob.result).includes(transcriptJob.result.srtPath));
  assert.ok(outputPaths(transcriptJob.result).includes(transcriptJob.result.jsonPath));
  assert.ok(!outputPaths(transcriptJob.result).includes(transcriptJob.result.modelPath));
  assert.equal(resultWarnings({ qa: { warnings: ['same'] }, steps: [{ result: { warnings: ['same'] } }] }).length, 1);
  assert.deepEqual(pageErrors, []);
  record('output discovery excludes model files, warnings deduplicate, and browser runtime has no errors');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ directory, checks, pageErrors }, null, 2));
  console.log(JSON.stringify({ url: app.url, directory, checks }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`Verification artifacts: ${directory}`);
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await engine.close();
}
