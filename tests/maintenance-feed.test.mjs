/**
 * Tests for the ported announcement feed (`src/maintenance-feed.mjs`).
 *
 * Ported from the upstream MIT project's feed tests
 * (`Ebony-Vinyl/dsh-our-free-model`, commit 0b712bcbb887ae101cae5fdf935b0845761a1421),
 * adapted to this repository's symbol/repo identity. Ack/read-marker state is
 * caller-owned, so these tests exercise `view({ ackedIds })` exactly as the
 * server will.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFeed, sortItems, fetchFeed, AnnouncementFeed, bustCdnCache, LEVELS,
} from '../src/maintenance-feed.mjs'

function fakeFetch(routes, { status = {} } = {}) {
  return async url => {
    const href = String(url)
    for (const [suffix, body] of Object.entries(routes)) {
      if (href.includes(suffix)) {
        const code = status[suffix] ?? 200
        return {
          ok: code >= 200 && code < 300,
          status: code,
          headers: { get: () => null },
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          body: null,
        }
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', body: null }
  }
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'eac-feed-'))
  try { return await fn(dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('bustCdnCache only stamps jsDelivr URLs', () => {
  const raw = 'https://raw.githubusercontent.com/x/y/main/feed/announcements.json'
  assert.equal(bustCdnCache(raw, 120_000), raw)
  const cdn = bustCdnCache('https://cdn.jsdelivr.net/gh/x/y@main/feed/announcements.json', 120_000)
  assert.match(cdn, /[?&]eac=2/)
})

test('parseFeed validates, dedupes, expires and sorts announcements', () => {
  const now = Date.parse('2026-05-01T00:00:00.000Z')
  const payload = {
    announcements: [
      { id: 'a', title: 'Older', createdAt: '2026-04-01T00:00:00.000Z' },
      { id: 'a', title: 'Duplicate id', createdAt: '2026-04-02T00:00:00.000Z' },
      { id: 'b', title: 'Pinned', createdAt: '2026-03-01T00:00:00.000Z', pinned: true, level: 'urgent' },
      { id: 'c', title: 'Expired', createdAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z' },
      { id: '', title: 'No id' },
      { id: 'd', title: '' },
      { id: 'e', title: 'Link', link: { url: 'https://example.test/x', label: 'Go' } },
      { id: 'f', title: 'Bad link', link: { url: 'javascript:alert(1)' } },
    ],
  }
  const { announcements } = parseFeed(payload, now)
  const ids = announcements.map(item => item.id)
  assert.equal(ids[0], 'b') // pinned first
  assert.ok(ids.includes('a') && ids.includes('e') && ids.includes('f'))
  assert.equal(ids.filter(id => id === 'a').length, 1) // duplicate id collapsed
  assert.ok(!ids.includes('c')) // expired dropped
  assert.ok(!ids.includes('d')) // empty title dropped
  assert.equal(announcements[0].level, 'urgent')
  assert.equal(announcements.find(i => i.id === 'e').link.url, 'https://example.test/x')
  assert.equal(announcements.find(i => i.id === 'f').link, undefined)
  assert.ok(LEVELS.has('info') && LEVELS.has('urgent'))
  // A non-feed document is rejected as a whole.
  assert.throws(() => parseFeed([]), /JSON object/)
  assert.throws(() => parseFeed({}), /announcements array/)
})

test('fetchFeed tries sources in order and fails only when none answer', async () => {
  const good = { announcements: [{ id: 'x', title: 'Hi', createdAt: '2026-01-01T00:00:00.000Z' }] }
  // Only good.example answers; bad.example must 404 so the second source wins.
  const routes = { 'good.example/feed/announcements.json': JSON.stringify(good) }
  const { feed, source } = await fetchFeed(
    ['https://bad.example/feed/announcements.json', 'https://good.example/feed/announcements.json'],
    { fetchImpl: fakeFetch(routes) },
  )
  assert.equal(feed.announcements[0].id, 'x')
  assert.match(source, /good\.example/)
  await assert.rejects(
    fetchFeed(['https://bad.example/feed/announcements.json'], { fetchImpl: fakeFetch({}) }),
    /no feed source answered/,
  )
})

test('a malformed feed is rejected as a whole rather than half-applied', async () => {
  const routes = { '/feed/announcements.json': '{"announcements": "not-an-array"}' }
  await assert.rejects(fetchFeed(['https://x.example/feed/announcements.json'], { fetchImpl: fakeFetch(routes) }), /no feed source answered/)
})

test('AnnouncementFeed caches the last good copy and reports arrivals once', async () => {
  await withTemp(async dir => {
    const cacheFile = join(dir, 'feed.json')
    const first = { announcements: [{ id: 'a', title: 'First', createdAt: '2026-01-01T00:00:00.000Z' }] }
    const second = { announcements: [
      { id: 'a', title: 'First', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: 'Second', createdAt: '2026-01-02T00:00:00.000Z' },
    ] }
    const arrivals = []
    const sources = ['https://x.example/feed/announcements.json']
    // First poll establishes the baseline: no arrivals are reported.
    const baseline = new AnnouncementFeed({
      settings: () => ({}), cacheFile, defaultSources: sources,
      fetchImpl: fakeFetch({ '/feed/announcements.json': JSON.stringify(first) }),
    })
    const firstPoll = await baseline.poll()
    assert.equal(firstPoll.arrived.length, 0)
    assert.ok(existsSync(cacheFile))

    // A second instance loads the cache, then polls a feed with a new item.
    const feed = new AnnouncementFeed({
      settings: () => ({}), cacheFile, defaultSources: sources,
      onArrival: items => arrivals.push(...items.map(i => i.id)),
      fetchImpl: fakeFetch({ '/feed/announcements.json': JSON.stringify(second) }),
    })
    feed.load(await readFile(cacheFile, 'utf8'))
    const polled = await feed.poll()
    assert.deepEqual(polled.arrived.map(i => i.id), ['b'])
    assert.deepEqual(arrivals, ['b'])

    // The view annotates ack state and counts unread from data.
    const view = feed.view({ ackedIds: ['b'] })
    assert.equal(view.unread, 1)
    assert.equal(view.items.find(i => i.id === 'b').acked, true)
    assert.equal(view.items.find(i => i.id === 'a').acked, false)
    assert.equal(typeof view.fetchedAt, 'number')
  })
})

test('a failed poll keeps serving the last cached copy', async () => {
  await withTemp(async dir => {
    const cacheFile = join(dir, 'feed.json')
    const polling = new AnnouncementFeed({
      settings: () => ({}), cacheFile,
      defaultSources: ['https://x.example/feed/announcements.json'],
      fetchImpl: fakeFetch({}),
    })
    polling.cache = { at: 1, source: 'cache', announcements: [{ id: 'a', title: 'Cached', level: 'info', html: '', createdAt: 1 }] }
    polling.knownIds = new Set(['a'])
    const result = await polling.poll()
    assert.equal(result.arrived.length, 0)
    assert.ok(polling.view().error.length > 0)
    // The cached item is still served after the failure.
    assert.equal(polling.view().items[0].id, 'a')
  })
})

test('feedUrl override must be https (loopback http allowed) and reorders sources', () => {
  const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: 'https://mirror.example/feed.json' }), cacheFile: 'x' })
  assert.equal(feed.sources()[0], 'https://mirror.example/feed.json')
  const plain = new AnnouncementFeed({ settings: () => ({ feedUrl: 'http://evil.example/feed.json' }), cacheFile: 'x' })
  assert.equal(plain.sources()[0].startsWith('https://raw.githubusercontent.com'), true)
  const loop = new AnnouncementFeed({ settings: () => ({ feedUrl: 'http://127.0.0.1:8080/feed.json' }), cacheFile: 'x' })
  assert.equal(loop.sources()[0], 'http://127.0.0.1:8080/feed.json')
})

test('sortItems is stable for equal timestamps', () => {
  const items = [
    { id: 'a', createdAt: 100 },
    { id: 'b', createdAt: 100 },
  ]
  assert.deepEqual(sortItems(items).map(i => i.id), ['a', 'b'])
})

test('expiry and order survive a persist -> load round-trip', async () => {
  await withTemp(async dir => {
    const cacheFile = join(dir, 'feed.json')
    const future = Date.now() + 3_600_000
    const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
    // Ingest a feed whose expiry is an ISO string, then persist it.
    const payload = { announcements: [
      { id: 'keep', title: 'Keep', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: new Date(future).toISOString() },
      { id: 'newer', title: 'Newer', createdAt: '2026-02-01T00:00:00.000Z' },
    ] }
    const ingested = parseFeed(payload)
    feed.cache = { at: Date.now(), source: 'test', announcements: ingested.announcements }
    feed.knownIds = new Set(ingested.announcements.map(i => i.id))
    feed.persist()

    // Reload from the cache the way a restart does.
    const reloaded = new AnnouncementFeed({ settings: () => ({}), cacheFile })
    reloaded.load(await readFile(cacheFile, 'utf8'))
    const view = reloaded.view()
    // The unexpired item is still present with its expiry intact...
    const keep = view.items.find(i => i.id === 'keep')
    assert.ok(keep, 'unexpired announcement must survive reload')
    assert.equal(typeof keep.expiresAt, 'number')
    assert.equal(keep.expiresAt, future)
    // ...and the newest-first order is preserved from numeric createdAt.
    assert.deepEqual(view.items.map(i => i.id), ['newer', 'keep'])
  })
})

test('an expired numeric timestamp is dropped on reload', async () => {
  await withTemp(async dir => {
    const cacheFile = join(dir, 'feed.json')
    const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
    feed.cache = {
      at: Date.now(), source: 'test',
      announcements: [
        { id: 'live', title: 'Live', level: 'info', html: '', createdAt: 1000 },
        { id: 'gone', title: 'Gone', level: 'info', html: '', createdAt: 1000, expiresAt: Date.now() - 1000 },
      ],
    }
    feed.persist()
    const reloaded = new AnnouncementFeed({ settings: () => ({}), cacheFile })
    reloaded.load(await readFile(cacheFile, 'utf8'))
    assert.deepEqual(reloaded.view().items.map(i => i.id), ['live'])
  })
})
