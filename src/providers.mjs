import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Stable provider ids; Commons is keyless while the other three need credentials. */
export const PROVIDER_IDS = ['pexels', 'pixabay', 'jamendo', 'commons'];

const DEFAULT_PER_PAGE = 12;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 800;
const COMMONS_USER_AGENT = 'EAC-design-world/0.5 (media workbench)';
const KIND_LABELS = Object.freeze({ video: '视频', music: '音乐' });

const PROVIDERS = Object.freeze({
  pexels: Object.freeze({
    kind: 'video',
    label: 'Pexels',
    setting: 'pexelsApiKey',
    docsUrl: 'https://www.pexels.com/api',
    maxPerPage: 80,
    missingNote: '未配置 Key；到 https://www.pexels.com/api 免费注册',
    readyNote: '已配置 Key；Pexels License 可免费商用',
    missingError: '未配置 Pexels API Key，无法搜索视频；请到 https://www.pexels.com/api 免费注册',
  }),
  pixabay: Object.freeze({
    kind: 'video',
    label: 'Pixabay',
    setting: 'pixabayApiKey',
    docsUrl: 'https://pixabay.com/api/docs/',
    maxPerPage: 24,
    missingNote: '未配置 Key；到 https://pixabay.com/api/docs/ 免费注册',
    readyNote: '已配置 Key；Pixabay Content License 可免费商用',
    missingError: '未配置 Pixabay API Key，无法搜索视频；请到 https://pixabay.com/api/docs/ 免费注册',
  }),
  jamendo: Object.freeze({
    kind: 'music',
    label: 'Jamendo',
    setting: 'jamendoClientId',
    docsUrl: 'https://developer.jamendo.com/v3.0',
    maxPerPage: 200,
    missingNote: '未配置 Client ID；到 https://devportal.jamendo.com 免费注册',
    readyNote: '已配置 Client ID；曲目多为 CC 授权，请保留署名',
    missingError: '未配置 Jamendo Client ID，无法搜索音乐；请到 https://devportal.jamendo.com 免费注册',
  }),
  commons: Object.freeze({
    kind: 'video',
    offers: ['video', 'music'],
    label: 'Wikimedia Commons',
    keyless: true,
    setting: null,
    docsUrl: 'https://commons.wikimedia.org/wiki/Commons:Video',
    maxPerPage: 50,
    missingNote: '维基共享，无需 Key',
    readyNote: '维基共享，无需 Key；视频与音频（CC 配乐）均可搜索',
    missingError: '维基共享，无需 Key',
  }),
});

/** Ten-minute in-memory search cache keyed by provider|kind|query|perPage. */
const searchCache = new Map();

function abortError() {
  return Object.assign(new Error('请求已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function hasKey(providerId, settings) {
  const value = settings?.[PROVIDERS[providerId].setting];
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function providerKey(providerId, settings) {
  const value = settings?.[PROVIDERS[providerId].setting];
  const key = value === undefined || value === null ? '' : String(value).trim();
  if (!key) throw new Error(PROVIDERS[providerId].missingError);
  return key;
}

function normalizeKind(kind) {
  if (kind !== 'video' && kind !== 'music') {
    throw new Error('kind 必须是 "video" 或 "music"');
  }
  return kind;
}

function providerOffers(providerId, kind) {
  const provider = PROVIDERS[providerId];
  return provider.offers ? provider.offers.includes(kind) : provider.kind === kind;
}

function selectProvider(kind, provider, settings) {
  if (provider !== undefined && provider !== null) {
    if (!PROVIDER_IDS.includes(provider)) throw new Error(`未知的素材提供方：${provider}`);
    if (!providerOffers(provider, kind)) {
      throw new Error(`不支持使用 ${provider} 搜索 ${kind}（${KIND_LABELS[kind]}）：${provider} 只提供 ${PROVIDERS[provider].offers?.join('、') ?? PROVIDERS[provider].kind}`);
    }
    return provider;
  }
  if (kind === 'music') {
    if (hasKey('jamendo', settings)) return 'jamendo';
    return 'commons';
  }
  if (hasKey('pexels', settings)) return 'pexels';
  if (hasKey('pixabay', settings)) return 'pixabay';
  return 'commons';
}

function pageLimit(providerId, perPage) {
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error('perPage 必须是正整数');
  return Math.min(perPage, PROVIDERS[providerId].maxPerPage);
}

function mediaFetch(fetchImpl) {
  const implementation = fetchImpl ?? globalThis.fetch;
  if (typeof implementation !== 'function') throw new Error('当前环境不支持 fetch，无法访问素材接口');
  return implementation;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/** Combines the caller signal with the 15 s deadline, preferring AbortSignal.any. */
function requestSignal(signal) {
  const timeout = timeoutSignal(SEARCH_TIMEOUT_MS);
  if (!signal) return { signal: timeout, timeout, cleanup: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([signal, timeout]), timeout, cleanup: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(timeout.reason), SEARCH_TIMEOUT_MS);
  timer.unref?.();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    timeout,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

function delay(ms, signal) {
  return new Promise((complete, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      complete();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function statusOf(response) {
  const status = Number(response?.status);
  if (Number.isInteger(status) && status > 0) return status;
  return response?.ok === false ? 400 : 200;
}

/**
 * Requests JSON with one retry on network failure or HTTP 5xx.
 * Aborts after 15 s; the caller signal always wins over the deadline.
 */
async function requestJson(url, { headers, fetchImpl, signal } = {}) {
  const request = mediaFetch(fetchImpl);
  const host = hostOf(url);
  for (let attempt = 0; ; attempt += 1) {
    checkAbort(signal);
    const { signal: combined, timeout, cleanup } = requestSignal(signal);
    let response;
    try {
      response = await request(url, { headers, signal: combined });
    } catch (error) {
      cleanup();
      if (signal?.aborted) throw abortError();
      if (timeout.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw Object.assign(new Error(`请求超时（15 秒）：${host}`), { name: 'TimeoutError', code: 'ETIMEDOUT' });
      }
      if (attempt === 0) {
        await delay(RETRY_DELAY_MS, signal);
        continue;
      }
      throw new Error(`网络请求失败（${host}）：${error?.message ?? '未知网络错误'}`);
    }
    cleanup();
    const status = statusOf(response);
    if (status >= 500) {
      if (attempt === 0) {
        await delay(RETRY_DELAY_MS, signal);
        continue;
      }
      throw new Error(`素材接口暂时不可用（${host} 返回 HTTP ${status}）`);
    }
    if (status >= 400) {
      throw new Error(`素材接口请求失败（${host} 返回 HTTP ${status}）`);
    }
    try {
      if (typeof response.json === 'function') return await response.json();
      const text = await response.text();
      return JSON.parse(text);
    } catch (error) {
      checkAbort(signal);
      if (timeout.aborted) {
        throw Object.assign(new Error(`请求超时（15 秒）：${host}`), { name: 'TimeoutError', code: 'ETIMEDOUT' });
      }
      if (error?.name === 'AbortError') throw abortError();
      throw new Error(`素材接口返回了无法解析的数据（${host}）`);
    }
  }
}

function textValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function plainText(value) {
  const named = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' };
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : entity;
      }
      return named[body.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function seconds(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function pixels(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function stockItem(provider, kind, fields) {
  return {
    provider,
    kind,
    id: fields.id,
    title: textValue(fields.title),
    author: textValue(fields.author),
    durationSec: seconds(fields.durationSec),
    width: pixels(fields.width),
    height: pixels(fields.height),
    previewUrl: textValue(fields.previewUrl),
    downloadUrl: textValue(fields.downloadUrl),
    license: textValue(fields.license),
    mimeType: textValue(fields.mimeType) || (kind === 'music' ? 'audio/mpeg' : 'video/mp4'),
    attribution: fields.attribution
      ? {
        author: textValue(fields.attribution.author),
        license: textValue(fields.attribution.license),
        sourceUrl: textValue(fields.attribution.sourceUrl),
      }
      : null,
  };
}

function pickPexelsFile(files) {
  const candidates = (Array.isArray(files) ? files : []).filter((file) => file && file.link);
  const mp4 = candidates.filter((file) => /mp4/i.test(file.file_type ?? '') || /\.mp4(?:[?#]|$)/i.test(file.link));
  const pool = mp4.length ? mp4 : candidates;
  for (const width of [1920, 1280]) {
    const match = pool.find((file) => Number(file.width) === width);
    if (match) return match;
  }
  return pool.slice().sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0))[0] ?? null;
}

function mapPexelsVideo(video) {
  const file = pickPexelsFile(video.video_files);
  return stockItem('pexels', 'video', {
    id: video.id,
    title: video.title ?? `Pexels 视频 ${video.id}`,
    author: video.user?.name,
    durationSec: video.duration,
    width: file?.width ?? video.width,
    height: file?.height ?? video.height,
    previewUrl: video.url,
    downloadUrl: file?.link,
    license: 'Pexels License',
    mimeType: file?.file_type || 'video/mp4',
    attribution: null,
  });
}

function mapPixabayVideo(video) {
  const file = [video.videos?.large, video.videos?.medium].find((candidate) => candidate?.url) ?? null;
  return stockItem('pixabay', 'video', {
    id: video.id,
    title: video.tags || `Pixabay 视频 ${video.id}`,
    author: video.user,
    durationSec: video.duration,
    width: file?.width ?? video.width,
    height: file?.height ?? video.height,
    previewUrl: video.pageURL ?? video.page,
    downloadUrl: file?.url,
    license: 'Pixabay Content License',
    mimeType: 'video/mp4',
    attribution: null,
  });
}

function mapJamendoTrack(track) {
  const license = track.license_ccurl ?? track.license ?? '';
  const author = track.artist_name ?? '';
  const sourceUrl = track.shareurl ?? '';
  return stockItem('jamendo', 'music', {
    id: track.id,
    title: track.name,
    author,
    durationSec: track.duration,
    width: 0,
    height: 0,
    previewUrl: sourceUrl,
    downloadUrl: track.audiodownload ?? track.audio,
    license,
    mimeType: 'audio/mpeg',
    attribution: { author, license, sourceUrl },
  });
}

const COMMONS_VIDEO_MIMES = new Set(['video/webm', 'video/mp4']);
const COMMONS_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'application/ogg', 'audio/wav', 'audio/x-wav']);

function mapCommonsPage(page, kind = 'video') {
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  const mime = String(info?.mime ?? '').toLowerCase();
  const mimeOk = kind === 'music' ? COMMONS_AUDIO_MIMES.has(mime) : COMMONS_VIDEO_MIMES.has(mime);
  if (!info?.url || !mimeOk) return null;
  const title = page.title;
  const sourceUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`;
  const license = plainText(info.extmetadata?.LicenseShortName?.value) || '未标注许可';
  const author = plainText(info.extmetadata?.Artist?.value) || '维基共享贡献者';
  return stockItem('commons', kind, {
    id: title,
    title,
    author,
    durationSec: info.duration,
    width: kind === 'music' ? 0 : info.width,
    height: kind === 'music' ? 0 : info.height,
    previewUrl: sourceUrl,
    downloadUrl: info.url,
    license,
    mimeType: mime,
    attribution: { author, license, sourceUrl },
  });
}

function widthRank(width) {
  if (width >= 1920) return 0;
  if (width >= 1280) return 1;
  return 2;
}

function durationRank(duration) {
  return duration >= 5 && duration <= 90 ? 0 : 1;
}

function sortResults(kind, results) {
  if (kind !== 'video') return results;
  return results
    .map((item, index) => ({ item, index }))
    .sort((a, b) => widthRank(a.item.width) - widthRank(b.item.width)
      || durationRank(a.item.durationSec) - durationRank(b.item.durationSec)
      || a.index - b.index)
    .map(({ item }) => item);
}

function cloneResults(results) {
  return results.map((item) => ({
    ...item,
    attribution: item.attribution ? { ...item.attribution } : null,
  }));
}

function usable(results) {
  return results.filter((item) => item && item.id !== undefined && item.id !== null && item.downloadUrl);
}

async function searchPexels({ query, limit, settings, fetchImpl, signal }) {
  const key = providerKey('pexels', settings);
  const url = `https://api.pexels.com/videos/search?${new URLSearchParams({
    query,
    per_page: String(limit),
    orientation: 'landscape',
  })}`;
  const data = await requestJson(url, { fetchImpl, signal, headers: { Authorization: key } });
  const videos = Array.isArray(data?.videos) ? data.videos : [];
  return usable(videos.map(mapPexelsVideo));
}

async function searchPixabay({ query, limit, settings, fetchImpl, signal }) {
  const key = providerKey('pixabay', settings);
  const url = `https://pixabay.com/api/videos/?${new URLSearchParams({
    key,
    q: query,
    per_page: String(limit),
  })}`;
  const data = await requestJson(url, { fetchImpl, signal });
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return usable(hits.map(mapPixabayVideo));
}

async function searchJamendo({ query, limit, settings, fetchImpl, signal }) {
  const key = providerKey('jamendo', settings);
  const url = `https://api.jamendo.com/v3.0/tracks/?${new URLSearchParams({
    client_id: key,
    format: 'json',
    limit: String(limit),
    search: query,
    audiodownload: '1',
    audioformat: 'mp32',
  })}`;
  const data = await requestJson(url, { fetchImpl, signal });
  const tracks = Array.isArray(data?.results) ? data.results : [];
  return usable(tracks.map(mapJamendoTrack));
}

async function searchCommons({ query, limit, kind, fetchImpl, signal }) {
  const fileType = kind === 'music' ? 'audio' : 'video';
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${query} filetype:${fileType}`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|mediaduration|extmetadata',
  })}`;
  const data = await requestJson(url, {
    fetchImpl,
    signal,
    headers: { 'User-Agent': COMMONS_USER_AGENT },
  });
  const pages = data?.query?.pages;
  const entries = pages && typeof pages === 'object' ? Object.values(pages) : [];
  return usable(entries.map((page) => mapCommonsPage(page, kind)).filter(Boolean));
}

/**
 * Describes every stock provider and whether the given settings can use it.
 * Wikimedia Commons is keyless and therefore always configured.
 * @param {object} [settings] Raw settings that may contain provider credentials.
 * @returns {Array<{ id: string, kind: 'video'|'music', configured: boolean, docsUrl: string, note: string }>}
 */
export function providerStatus(settings = {}) {
  const values = settings && typeof settings === 'object' ? settings : {};
  return PROVIDER_IDS.map((id) => {
    const provider = PROVIDERS[id];
    const configured = provider.keyless === true || hasKey(id, values);
    return {
      id,
      kind: provider.kind,
      configured,
      docsUrl: provider.docsUrl,
      note: configured ? provider.readyNote : provider.missingNote,
    };
  });
}

/**
 * Searches one stock provider and caches successful answers for ten minutes.
 * Omitting `provider` picks Pexels, then Pixabay, then keyless Commons for video,
 * and Jamendo for music.
 * @param {object} options Search options.
 * @param {'video'|'music'} options.kind Media kind.
 * @param {string} options.query Free-text query.
 * @param {'pexels'|'pixabay'|'jamendo'|'commons'} [options.provider] Optional provider id.
 * @param {number} [options.perPage] Number of requested items (provider-clamped).
 * @param {object} [options.settings] Provider credentials.
 * @param {Function} [options.fetchImpl] Injectable fetch implementation.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @returns {Promise<{ provider: string, results: object[] }>}
 */
export async function searchStock({
  kind, query, provider, perPage = DEFAULT_PER_PAGE, settings = {}, fetchImpl, signal,
} = {}) {
  const mediaKind = normalizeKind(kind);
  if (typeof query !== 'string' || !query.trim()) throw new Error('搜索关键词 query 不能为空');
  const text = query.trim();
  const providerId = selectProvider(mediaKind, provider, settings);
  const limit = pageLimit(providerId, perPage);
  const cacheKey = `${providerId}|${mediaKind}|${text}|${limit}`;

  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return { provider: providerId, results: cloneResults(cached.results) };
  }
  if (cached) searchCache.delete(cacheKey);
  checkAbort(signal);

  const options = { query: text, limit, kind: mediaKind, settings, fetchImpl, signal };
  let results;
  if (providerId === 'pexels') results = await searchPexels(options);
  else if (providerId === 'pixabay') results = await searchPixabay(options);
  else if (providerId === 'jamendo') results = await searchJamendo(options);
  else results = await searchCommons(options);

  if (results.length === 0) {
    throw new Error(`没有找到与“${text}”匹配的${KIND_LABELS[mediaKind]}素材（${providerId}）`);
  }
  const sorted = sortResults(mediaKind, results);
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (now - entry.createdAt >= CACHE_TTL_MS) searchCache.delete(key);
  }
  searchCache.set(cacheKey, { createdAt: now, results: sorted });
  return { provider: providerId, results: cloneResults(sorted) };
}

async function resolvePexels({ id, settings, fetchImpl, signal }) {
  const key = providerKey('pexels', settings);
  const url = `https://api.pexels.com/videos/videos/${encodeURIComponent(String(id))}`;
  const data = await requestJson(url, { fetchImpl, signal, headers: { Authorization: key } });
  const video = data?.video ?? data;
  if (!video || typeof video !== 'object' || video.id === undefined || video.id === null) {
    throw new Error(`没有找到 Pexels 视频：${id}`);
  }
  const item = mapPexelsVideo(video);
  if (!item.downloadUrl) throw new Error(`Pexels 视频 ${id} 没有可下载文件`);
  return item;
}

async function resolvePixabay({ id, settings, fetchImpl, signal }) {
  const key = providerKey('pixabay', settings);
  const url = `https://pixabay.com/api/videos/?${new URLSearchParams({
    key,
    id: String(id),
  })}`;
  const data = await requestJson(url, { fetchImpl, signal });
  const video = Array.isArray(data?.hits) ? data.hits[0] : null;
  if (!video) throw new Error(`没有找到 Pixabay 视频：${id}`);
  const item = mapPixabayVideo(video);
  if (!item.downloadUrl) throw new Error(`Pixabay 视频 ${id} 没有可下载文件`);
  return item;
}

async function resolveJamendo({ id, settings, fetchImpl, signal }) {
  const key = providerKey('jamendo', settings);
  const url = `https://api.jamendo.com/v3.0/tracks/?${new URLSearchParams({
    client_id: key,
    format: 'json',
    id: String(id),
  })}`;
  const data = await requestJson(url, { fetchImpl, signal });
  const track = Array.isArray(data?.results) ? data.results[0] : null;
  if (!track) throw new Error(`没有找到 Jamendo 曲目：${id}`);
  const item = mapJamendoTrack(track);
  if (!item.downloadUrl) throw new Error(`Jamendo 曲目 ${id} 没有可下载文件`);
  return item;
}

async function resolveCommons({ id, kind, fetchImpl, signal }) {
  const title = String(id);
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: title,
    prop: 'imageinfo',
    iiprop: 'url|size|mime|mediaduration|extmetadata',
  })}`;
  const data = await requestJson(url, {
    fetchImpl,
    signal,
    headers: { 'User-Agent': COMMONS_USER_AGENT },
  });
  const pages = data?.query?.pages;
  const page = pages && typeof pages === 'object' ? Object.values(pages)[0] : null;
  const item = page ? mapCommonsPage(page, kind === 'music' ? 'music' : 'video') : null;
  if (!item) throw new Error(`没有找到维基共享文件：${title}`);
  return item;
}

/**
 * Re-fetches one stock item by provider id, for download jobs resumed after a restart.
 * @param {object} options Resolve options.
 * @param {'pexels'|'pixabay'|'jamendo'|'commons'} options.provider Provider id.
 * @param {'video'|'music'} [options.kind] Expected media kind.
 * @param {string|number} options.id Provider item id (Commons uses the File: title).
 * @param {object} [options.settings] Provider credentials.
 * @param {Function} [options.fetchImpl] Injectable fetch implementation.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @returns {Promise<object>} One item shaped exactly like a search result entry.
 */
export async function resolveStockItem({
  provider, kind, id, settings = {}, fetchImpl, signal,
} = {}) {
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`未知的素材提供方：${provider}`);
  let expected = null;
  if (kind !== undefined && kind !== null) expected = normalizeKind(kind);
  if (expected !== null && !providerOffers(provider, expected)) {
    throw new Error(`不支持使用 ${provider} 获取 ${expected}（${KIND_LABELS[expected]}）：${provider} 只提供 ${PROVIDERS[provider].offers?.join('、') ?? PROVIDERS[provider].kind}`);
  }
  if (id === undefined || id === null || !String(id).trim()) throw new Error('素材 id 不能为空');
  checkAbort(signal);
  if (provider === 'pexels') return resolvePexels({ id, settings, fetchImpl, signal });
  if (provider === 'pixabay') return resolvePixabay({ id, settings, fetchImpl, signal });
  if (provider === 'jamendo') return resolveJamendo({ id, settings, fetchImpl, signal });
  return resolveCommons({ id, kind: expected ?? 'video', fetchImpl, signal });
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function contentLength(headers) {
  const value = headerValue(headers, 'content-length');
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function closeWriteStream(stream) {
  if (stream.closed) return Promise.resolve();
  return new Promise((complete) => {
    stream.once('close', complete);
    stream.destroy();
  });
}

/**
 * Streams a remote media file to disk with a hard byte cap.
 * Non-2xx responses fail before any file is created; every later failure removes
 * the partial file. Abort is honored while the body streams.
 * @param {object} options Download options.
 * @param {string} options.url Direct media URL.
 * @param {string} options.outputPath Local destination path.
 * @param {number} [options.maxBytes] Hard size cap (default 600 MiB).
 * @param {Function} [options.fetchImpl] Injectable fetch implementation.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @param {(progress: { received: number, total: number|null }) => void} [options.onProgress] Chunk callback.
 * @returns {Promise<{ outputPath: string, bytes: number, total: number|null }>}
 */
export async function downloadStockFile({
  url, outputPath, maxBytes = 600 * 1024 * 1024, fetchImpl, signal, onProgress,
} = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('下载地址必须是 http(s) URL');
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new TypeError('outputPath 必须是非空的本地文件路径');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes 必须是正数');
  checkAbort(signal);
  const request = mediaFetch(fetchImpl);
  const target = resolve(outputPath);
  const host = hostOf(url);
  await mkdir(dirname(target), { recursive: true });

  let response;
  try {
    response = await request(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw new Error(`下载请求失败（${host}）：${error?.message ?? '未知网络错误'}`);
  }
  const status = statusOf(response);
  if (status < 200 || status >= 300) throw new Error(`下载失败（${host} 返回 HTTP ${status}）`);
  const total = contentLength(response.headers);
  if (total !== null && total > maxBytes) {
    throw new Error(`文件大小 ${total} 字节超过上限 ${maxBytes} 字节`);
  }
  if (!response.body) throw new Error(`下载响应没有内容（${host}）`);
  checkAbort(signal);

  const output = createWriteStream(target);
  let streamError = null;
  output.on('error', (error) => {
    streamError ??= error;
  });
  // Node streams would otherwise emit an unhandled error when abort destroys the body.
  try { response.body.on?.('error', () => {}); } catch { /* web streams are not event emitters */ }
  const iterator = response.body[Symbol.asyncIterator]();
  const abort = () => {
    try { response.body.destroy?.(abortError()); } catch { /* already closed */ }
    try { response.body.cancel?.(abortError())?.catch?.(() => {}); } catch { /* already closed */ }
    try { iterator.return?.()?.catch?.(() => {}); } catch { /* already closed */ }
  };
  signal?.addEventListener('abort', abort, { once: true });

  let received = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const { value, done } = await iterator.next();
      if (done) break;
      if (value === undefined || value === null) continue;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes) throw new Error(`下载流超过上限 ${maxBytes} 字节`);
      if (!output.write(chunk)) await once(output, 'drain');
      if (streamError) throw streamError;
      onProgress?.({ received, total });
    }
    output.end();
    await once(output, 'finish');
    if (streamError) throw streamError;
    return { outputPath: target, bytes: received, total };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await closeWriteStream(output);
    await rm(target, { force: true });
    if (signal?.aborted) throw abortError();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Reports the number of live search cache entries, used by tests and status screens.
 * @returns {{ size: number }}
 */
export function stockCacheInfo() {
  return { size: searchCache.size };
}
