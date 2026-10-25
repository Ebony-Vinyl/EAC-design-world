import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  PROVIDER_IDS,
  downloadStockFile,
  providerStatus,
  resolveStockItem,
  searchStock,
  stockCacheInfo,
} from '../src/providers.mjs';

const COMMONS_USER_AGENT = 'EAC-design-world/0.5 (media workbench)';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => data,
  };
}

function pexelsVideo(overrides = {}) {
  return {
    id: 1,
    width: 1920,
    height: 1080,
    duration: 30,
    url: 'https://www.pexels.com/video/1/',
    user: { name: 'Author' },
    video_files: [
      { width: 1920, height: 1080, link: 'https://cdn.pexels.com/1-1920.mp4', file_type: 'video/mp4' },
    ],
    ...overrides,
  };
}

function pixabayHit(overrides = {}) {
  return {
    id: 21,
    pageURL: 'https://pixabay.com/videos/id-21/',
    tags: 'river, nature',
    duration: 33,
    user: 'PixUser',
    videos: {
      large: { url: 'https://cdn.pixabay.com/21-large.mp4', width: 1920, height: 1080 },
      medium: { url: 'https://cdn.pixabay.com/21-medium.mp4', width: 1280, height: 720 },
    },
    ...overrides,
  };
}

function jamendoTrack(overrides = {}) {
  return {
    id: '99',
    name: 'Sunrise',
    artist_name: 'Night Owl',
    duration: 123,
    audiodownload: 'https://storage.jamendo.com/99.mp3',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
    shareurl: 'https://www.jamendo.com/track/99',
    ...overrides,
  };
}

function commonsPage({
  title = 'File:Sunset.webm',
  mime = 'video/webm',
  artist = '<a href="https://commons.wikimedia.org/wiki/User:Alice">Alice &amp; Bob</a>',
  license = 'CC BY-SA 4.0',
} = {}) {
  return {
    title,
    imageinfo: [{
      url: `https://upload.wikimedia.org/${encodeURIComponent(title)}`,
      width: 1920,
      height: 1080,
      mime,
      size: 12_345,
      extmetadata: {
        LicenseShortName: { value: license },
        Artist: { value: artist },
      },
    }],
  };
}

async function temporaryOutput(t, name = 'stock.bin') {
  const directory = await mkdtemp(join(tmpdir(), 'eac-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, name);
}

test('provider status marks keyless Commons as always configured', () => {
  const status = providerStatus({});
  assert.deepEqual(status.map((entry) => entry.id), PROVIDER_IDS);
  assert.deepEqual(status.map((entry) => entry.kind), ['video', 'video', 'music', 'video']);
  for (const id of ['pexels', 'pixabay', 'jamendo']) {
    const entry = status.find((candidate) => candidate.id === id);
    assert.equal(entry.configured, false);
    assert.match(entry.docsUrl, /^https:\/\//);
  }
  assert.match(status.find((entry) => entry.id === 'pexels').note, /未配置 Key；到 https:\/\/www\.pexels\.com\/api/);
  assert.match(status.find((entry) => entry.id === 'jamendo').note, /未配置 Client ID/);
  const commons = status.find((entry) => entry.id === 'commons');
  assert.equal(commons.configured, true);
  assert.match(commons.note, /维基共享，无需 Key/);

  const configured = providerStatus({ pexelsApiKey: ' a ', pixabayApiKey: 'b', jamendoClientId: 'c' });
  assert.ok(configured.every((entry) => entry.configured));
  assert.ok(configured.every((entry) => typeof entry.note === 'string' && entry.note.length > 0));
  assert.equal(providerStatus({ pexelsApiKey: '   ' })[0].configured, false);
});

test('Pexels search sends the raw key header, maps files, and ranks resolution then duration', async () => {
  const query = 'pexels search mapping';
  const calls = [];
  const videos = [
    {
      id: 10, width: 640, height: 360, duration: 20,
      url: 'https://www.pexels.com/video/10/', user: { name: 'Low' },
      video_files: [{ width: 640, height: 360, link: 'https://cdn.pexels.com/10.mp4', file_type: 'video/mp4' }],
    },
    {
      id: 11, width: 1920, height: 1080, duration: 60,
      url: 'https://www.pexels.com/video/11/', user: { name: 'Long' },
      video_files: [
        { width: 1280, height: 720, link: 'https://cdn.pexels.com/11-720.mp4', file_type: 'video/mp4' },
        { width: 1920, height: 1080, link: 'https://cdn.pexels.com/11-1080.mp4', file_type: 'video/mp4' },
      ],
    },
    {
      id: 12, width: 1920, height: 1080, duration: 2,
      url: 'https://www.pexels.com/video/12/', user: { name: 'Short' },
      video_files: [{ width: 1920, height: 1080, link: 'https://cdn.pexels.com/12.mp4', file_type: 'video/mp4' }],
    },
    {
      id: 13, width: 1280, height: 720, duration: 45,
      url: 'https://www.pexels.com/video/13/', user: { name: 'Mid' },
      video_files: [{ width: 1280, height: 720, link: 'https://cdn.pexels.com/13.mp4', file_type: 'video/mp4' }],
    },
  ];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return jsonResponse({ videos });
  };

  const result = await searchStock({
    kind: 'video', provider: 'pexels', query, settings: { pexelsApiKey: 'pexels-secret' }, fetchImpl,
  });

  assert.equal(result.provider, 'pexels');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://api.pexels.com/videos/search');
  assert.equal(parsed.searchParams.get('query'), query);
  assert.equal(parsed.searchParams.get('per_page'), '12');
  assert.equal(parsed.searchParams.get('orientation'), 'landscape');
  assert.equal(options.headers.Authorization, 'pexels-secret');
  assert.deepEqual(result.results.map((item) => item.id), [11, 12, 13, 10]);
  assert.deepEqual(result.results[0], {
    provider: 'pexels',
    kind: 'video',
    id: 11,
    title: 'Pexels 视频 11',
    author: 'Long',
    durationSec: 60,
    width: 1920,
    height: 1080,
    previewUrl: 'https://www.pexels.com/video/11/',
    downloadUrl: 'https://cdn.pexels.com/11-1080.mp4',
    license: 'Pexels License',
    mimeType: 'video/mp4',
    attribution: null,
  });
});

test('Pixabay search passes key and query params and prefers the large file', async () => {
  const query = 'pixabay search mapping';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({ hits: [pixabayHit()] });
  };
  const result = await searchStock({
    kind: 'video', provider: 'pixabay', query, settings: { pixabayApiKey: 'pixabay-secret' }, fetchImpl,
  });

  const parsed = new URL(calls[0]);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://pixabay.com/api/videos/');
  assert.equal(parsed.searchParams.get('key'), 'pixabay-secret');
  assert.equal(parsed.searchParams.get('q'), query);
  assert.equal(parsed.searchParams.get('per_page'), '12');
  assert.deepEqual(result.results, [{
    provider: 'pixabay',
    kind: 'video',
    id: 21,
    title: 'river, nature',
    author: 'PixUser',
    durationSec: 33,
    width: 1920,
    height: 1080,
    previewUrl: 'https://pixabay.com/videos/id-21/',
    downloadUrl: 'https://cdn.pixabay.com/21-large.mp4',
    license: 'Pixabay Content License',
    mimeType: 'video/mp4',
    attribution: null,
  }]);
});

test('Jamendo search maps CC music with attribution metadata', async () => {
  const query = 'jamendo search mapping';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({ results: [jamendoTrack()] });
  };
  const result = await searchStock({
    kind: 'music', provider: 'jamendo', query, settings: { jamendoClientId: 'jamendo-client' }, fetchImpl,
  });

  const parsed = new URL(calls[0]);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://api.jamendo.com/v3.0/tracks/');
  assert.equal(parsed.searchParams.get('client_id'), 'jamendo-client');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('limit'), '12');
  assert.equal(parsed.searchParams.get('search'), query);
  assert.equal(parsed.searchParams.get('audiodownload'), '1');
  assert.equal(parsed.searchParams.get('audioformat'), 'mp32');
  assert.deepEqual(result.results, [{
    provider: 'jamendo',
    kind: 'music',
    id: '99',
    title: 'Sunrise',
    author: 'Night Owl',
    durationSec: 123,
    width: 0,
    height: 0,
    previewUrl: 'https://www.jamendo.com/track/99',
    downloadUrl: 'https://storage.jamendo.com/99.mp3',
    license: 'https://creativecommons.org/licenses/by/4.0/',
    mimeType: 'audio/mpeg',
    attribution: {
      author: 'Night Owl',
      license: 'https://creativecommons.org/licenses/by/4.0/',
      sourceUrl: 'https://www.jamendo.com/track/99',
    },
  }]);
});

test('Commons search sends the required User-Agent and keeps only video mime types', async () => {
  const query = 'commons search mapping';
  const calls = [];
  const pages = {
    501: commonsPage(),
    502: commonsPage({ title: 'File:Photo.jpg', mime: 'image/jpeg' }),
  };
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return jsonResponse({ query: { pages } });
  };
  const result = await searchStock({ kind: 'video', query, provider: 'commons', fetchImpl });

  const [url, options] = calls[0];
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://commons.wikimedia.org/w/api.php');
  assert.equal(parsed.searchParams.get('action'), 'query');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('generator'), 'search');
  assert.equal(parsed.searchParams.get('gsrsearch'), `${query} filetype:video`);
  assert.equal(parsed.searchParams.get('gsrnamespace'), '6');
  assert.equal(parsed.searchParams.get('gsrlimit'), '12');
  assert.equal(parsed.searchParams.get('prop'), 'imageinfo');
  assert.equal(parsed.searchParams.get('iiprop'), 'url|size|mime|mediaduration|extmetadata');
  assert.equal(options.headers['User-Agent'], COMMONS_USER_AGENT);

  assert.equal(result.provider, 'commons');
  assert.equal(result.results.length, 1);
  const previewUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent('File:Sunset.webm')}`;
  assert.deepEqual(result.results[0], {
    provider: 'commons',
    kind: 'video',
    id: 'File:Sunset.webm',
    title: 'File:Sunset.webm',
    author: 'Alice & Bob',
    durationSec: 0,
    width: 1920,
    height: 1080,
    previewUrl,
    downloadUrl: 'https://upload.wikimedia.org/File%3ASunset.webm',
    license: 'CC BY-SA 4.0',
    mimeType: 'video/webm',
    attribution: { author: 'Alice & Bob', license: 'CC BY-SA 4.0', sourceUrl: previewUrl },
  });
});

test('provider defaults prefer Pexels, then Pixabay, then keyless Commons', async () => {
  const pixabayCalls = [];
  const pixabayResult = await searchStock({
    kind: 'video',
    query: 'default-provider-pixabay',
    settings: { pixabayApiKey: 'pix-key' },
    fetchImpl: async (url) => {
      pixabayCalls.push(url);
      return jsonResponse({ hits: [pixabayHit()] });
    },
  });
  assert.equal(pixabayResult.provider, 'pixabay');
  assert.match(pixabayCalls[0], /pixabay\.com\/api\/videos/);

  const commonsCalls = [];
  const commonsResult = await searchStock({
    kind: 'video',
    query: 'default-provider-commons',
    settings: {},
    fetchImpl: async (url) => {
      commonsCalls.push(url);
      return jsonResponse({ query: { pages: { 1: commonsPage() } } });
    },
  });
  assert.equal(commonsResult.provider, 'commons');
  assert.match(commonsCalls[0], /commons\.wikimedia\.org/);
});

test('empty provider results produce a Chinese error', async () => {
  await assert.rejects(searchStock({
    kind: 'video',
    provider: 'pexels',
    query: 'empty-results-query',
    settings: { pexelsApiKey: 'key' },
    fetchImpl: async () => jsonResponse({ videos: [] }),
  }), /没有找到/);
});

test('missing credentials fail with Chinese guidance before any request', async () => {
  let called = false;
  const neverFetch = async () => {
    called = true;
    return jsonResponse({});
  };
  await assert.rejects(searchStock({
    kind: 'video', provider: 'pexels', query: 'missing-pexels-key', settings: {}, fetchImpl: neverFetch,
  }), /未配置 Pexels API Key/);
  await assert.rejects(searchStock({
    kind: 'music', provider: 'jamendo', query: 'missing-jamendo-key', settings: {}, fetchImpl: neverFetch,
  }), /未配置 Jamendo Client ID/);
  assert.equal(called, false);
});

test('keyless Commons serves as the default music provider without credentials', async () => {
  const calls = [];
  const result = await searchStock({
    kind: 'music', query: 'ambient piano', settings: {},
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ query: { pages: {
        601: commonsPage({ title: 'File:Ambient.flac', mime: 'audio/flac' }),
      } } });
    },
  });
  assert.equal(result.provider, 'commons');
  assert.match(calls[0], /filetype(%3A|:)audio/i);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].kind, 'music');
  assert.equal(result.results[0].mimeType, 'audio/flac');
  assert.equal(result.results[0].width, 0);
});

test('invalid kind and provider combinations fail in Chinese', async () => {
  await assert.rejects(searchStock({
    kind: 'music', provider: 'pexels', query: 'bad-combo-pexels',
  }), /不支持.*pexels.*只提供/);
  await assert.rejects(searchStock({
    kind: 'video', provider: 'jamendo', query: 'bad-combo-jamendo',
  }), /不支持.*jamendo.*只提供/);
  await assert.rejects(searchStock({ kind: 'audio', query: 'bad-kind' }), /kind/);
  await assert.rejects(searchStock({ kind: 'video', query: '   ' }), /query/);
});

test('search retries once after an HTTP 5xx and then succeeds', { timeout: 5_000 }, async () => {
  const query = 'retry-then-success';
  let calls = 0;
  const result = await searchStock({
    kind: 'video',
    provider: 'pexels',
    query,
    settings: { pexelsApiKey: 'key' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, headers: new Map(), json: async () => ({}) };
      return jsonResponse({ videos: [pexelsVideo({ id: 7 })] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 7);
});

test('search cache serves identical queries without another fetch', async () => {
  const query = 'cache-hit-query';
  let calls = 0;
  const settings = { pexelsApiKey: 'key' };
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ videos: [pexelsVideo({ id: 5 })] });
  };
  const before = stockCacheInfo().size;
  const first = await searchStock({ kind: 'video', provider: 'pexels', query, settings, fetchImpl });
  assert.equal(stockCacheInfo().size, before + 1);
  first.results[0].title = 'mutated by caller';
  const second = await searchStock({ kind: 'video', provider: 'pexels', query, settings, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(stockCacheInfo().size, before + 1);
  assert.equal(second.results[0].title, 'Pexels 视频 5');
});

test('resolveStockItem re-fetches one Pexels video by id', async () => {
  const calls = [];
  const video = {
    id: 42, width: 1920, height: 1080, duration: 28,
    url: 'https://www.pexels.com/video/42/', user: { name: 'Rita' },
    video_files: [{ width: 1920, height: 1080, link: 'https://cdn.pexels.com/42.mp4', file_type: 'video/mp4' }],
  };
  const item = await resolveStockItem({
    provider: 'pexels',
    kind: 'video',
    id: 42,
    settings: { pexelsApiKey: 'resolve-secret' },
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return jsonResponse(video);
    },
  });
  assert.equal(calls[0][0], 'https://api.pexels.com/videos/videos/42');
  assert.equal(calls[0][1].headers.Authorization, 'resolve-secret');
  assert.deepEqual(item, {
    provider: 'pexels',
    kind: 'video',
    id: 42,
    title: 'Pexels 视频 42',
    author: 'Rita',
    durationSec: 28,
    width: 1920,
    height: 1080,
    previewUrl: 'https://www.pexels.com/video/42/',
    downloadUrl: 'https://cdn.pexels.com/42.mp4',
    license: 'Pexels License',
    mimeType: 'video/mp4',
    attribution: null,
  });
});

test('resolveStockItem uses the Pixabay id query parameter', async () => {
  const calls = [];
  const item = await resolveStockItem({
    provider: 'pixabay',
    kind: 'video',
    id: 21,
    settings: { pixabayApiKey: 'pixabay-resolve-key' },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ hits: [pixabayHit()] });
    },
  });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('key'), 'pixabay-resolve-key');
  assert.equal(parsed.searchParams.get('id'), '21');
  assert.equal(item.id, 21);
  assert.equal(item.provider, 'pixabay');
  assert.equal(item.downloadUrl, 'https://cdn.pixabay.com/21-large.mp4');
  assert.equal(item.license, 'Pixabay Content License');
});

test('resolveStockItem re-fetches a Jamendo track with attribution', async () => {
  const calls = [];
  const item = await resolveStockItem({
    provider: 'jamendo',
    kind: 'music',
    id: '99',
    settings: { jamendoClientId: 'jamendo-resolve-key' },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ results: [jamendoTrack()] });
    },
  });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('client_id'), 'jamendo-resolve-key');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('id'), '99');
  assert.equal(item.title, 'Sunrise');
  assert.equal(item.mimeType, 'audio/mpeg');
  assert.deepEqual(item.attribution, {
    author: 'Night Owl',
    license: 'https://creativecommons.org/licenses/by/4.0/',
    sourceUrl: 'https://www.jamendo.com/track/99',
  });
});

test('resolveStockItem fetches a Commons file by encoded title', async () => {
  const title = 'File:Resolved.webm';
  const calls = [];
  const item = await resolveStockItem({
    provider: 'commons',
    kind: 'video',
    id: title,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return jsonResponse({ query: { pages: { 777: commonsPage({ title }) } } });
    },
  });
  const [url, options] = calls[0];
  assert.ok(url.includes(`titles=${encodeURIComponent(title)}`));
  assert.equal(new URL(url).searchParams.get('titles'), title);
  assert.equal(options.headers['User-Agent'], COMMONS_USER_AGENT);
  assert.equal(item.id, title);
  assert.equal(item.provider, 'commons');
  assert.equal(item.license, 'CC BY-SA 4.0');
  assert.equal(item.attribution.author, 'Alice & Bob');
});

test('downloadStockFile streams the body, reports progress, and writes every byte', async (t) => {
  const output = await temporaryOutput(t);
  const progress = [];
  const result = await downloadStockFile({
    url: 'https://cdn.example.com/clip.mp4',
    outputPath: output,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '6']]),
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    }),
    onProgress: (event) => progress.push(event),
  });
  assert.equal(await readFile(output, 'utf8'), 'abcdef');
  assert.equal(result.bytes, 6);
  assert.deepEqual(progress.map((event) => event.received), [3, 6]);
  assert.ok(progress.every((event) => event.total === 6));
});

test('downloadStockFile rejects oversized content-length and leaves no partial file', async (t) => {
  const output = await temporaryOutput(t);
  await assert.rejects(downloadStockFile({
    url: 'https://cdn.example.com/big.mp4',
    outputPath: output,
    maxBytes: 4,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '6' }),
      body: Readable.from([Buffer.from('abcdef')]),
    }),
  }), /超过上限/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('downloadStockFile stops a stream that grows past maxBytes and removes it', async (t) => {
  const output = await temporaryOutput(t);
  await assert.rejects(downloadStockFile({
    url: 'https://cdn.example.com/stream.mp4',
    outputPath: output,
    maxBytes: 4,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    }),
  }), /超过上限/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('downloadStockFile rejects non-2xx responses before creating the file', async (t) => {
  const output = await temporaryOutput(t);
  await assert.rejects(downloadStockFile({
    url: 'https://cdn.example.com/missing.mp4',
    outputPath: output,
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: new Map(),
      body: null,
    }),
  }), /HTTP 404/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
