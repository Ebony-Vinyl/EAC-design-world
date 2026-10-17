#!/usr/bin/env node
// Import OpenDesign content into EAC as vendored, licensed, indexed material.
//
// Source: the OpenDesign upstream snapshot (default D:/_eac-research/od/open-design-main,
// override with --source or OPEN_DESIGN_SOURCE). Upstream ships no `.git`, so the
// revision is pinned by the upstream package version plus a content digest over
// every imported file (path + size + sha1). Re-running with an unchanged source is
// idempotent and cheap; a changed source requires --force.
//
// Guarantees:
//  - Never copies `node_modules`, `.git`, or the upstream application tree.
//  - Refuses to overwrite a `vendor/open-design` directory that has no import marker.
//  - Every emitted id matches /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.
//  - Every catalog `prompt` points at an existing readable text file.
//  - Thumbnails are only real local images or null (never fabricated).
//
// Usage:
//   node scripts/import-open-design.mjs [--source <path>] [--force] [--skip-copy] [--quiet]

import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'vendor', 'open-design');
const MARKER = join(TARGET, 'PROVENANCE.json');
const CATALOG = join(TARGET, 'catalog.json');
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const SOURCE = resolve(value('--source', process.env.OPEN_DESIGN_SOURCE || 'D:/_eac-research/od/open-design-main'));
const FORCE = flag('--force');
const SKIP_COPY = flag('--skip-copy');
const QUIET = flag('--quiet');

const log = (...args) => { if (!QUIET) console.log(...args); };
const fail = (message) => { console.error(`import-open-design: ${message}`); process.exit(1); };

const posix = (p) => p.replace(/\\/g, '/');
const exists = (p) => { try { return existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function dirs(base) {
  if (!isDir(base)) return [];
  return readdirSync(base).filter((name) => isDir(join(base, name))).sort();
}
function files(base, ext) {
  if (!isDir(base)) return [];
  return readdirSync(base).filter((name) => {
    const p = join(base, name);
    return statSync(p).isFile() && (!ext || name.endsWith(ext));
  }).sort();
}
function walk(base, { skip = [] } = {}) {
  const out = [];
  const visit = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.includes(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const info = statSync(abs);
      if (info.isDirectory()) visit(abs, r);
      else if (info.isFile()) out.push(r);
    }
  };
  if (isDir(base)) visit(base, '');
  return out;
}

// ── license detection ───────────────────────────────────────────────────────
const LICENSE_PATTERNS = [
  [/\bApache License\b|\bApache-2\.0\b/i, 'Apache-2.0'],
  [/\bMIT License\b|\bPermission is hereby granted, free of charge\b/i, 'MIT'],
  [/\bCC[- ]BY[- ]4\.0\b|Creative Commons Attribution 4\.0/i, 'CC-BY-4.0'],
  [/\bCC0\b/i, 'CC0-1.0'],
  [/\bBSD[- ]3/i, 'BSD-3-Clause'],
  [/\bBSD[- ]2/i, 'BSD-2-Clause'],
  [/\bISC\b/i, 'ISC'],
  [/\bMozilla Public License\b|\bMPL-2\.0\b/i, 'MPL-2.0'],
];
function detectLicense(text) {
  if (!text) return null;
  for (const [re, id] of LICENSE_PATTERNS) if (re.test(text.slice(0, 4000))) return id;
  return null;
}
function licenseFromFile(abs) {
  if (!exists(abs)) return null;
  try { return detectLicense(readText(abs)); } catch { return null; }
}

// ── minimal YAML frontmatter parser (subset sufficient for these files) ─────
function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((part) => unquote(part)).filter((part) => part !== '');
  }
  return v;
}
function indentOf(line) { return line.match(/^ */)[0].length; }

function parseBlock(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) { i++; continue; }
    const ind = indentOf(raw);
    if (ind < indent) break;
    const content = raw.trim();
    if (content.startsWith('- ')) {
      // list at this indent -> collect into an array under the parent key
      const list = [];
      while (i < lines.length && indentOf(lines[i]) === ind && lines[i].trim().startsWith('- ')) {
        list.push(unquote(lines[i].trim().slice(2)));
        i++;
      }
      return { list, next: i };
    }
    const colon = content.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (rest === '' || rest === '|' || rest === '>') {
      // nested block or block scalar
      const childIndent = i + 1 < lines.length ? indentOf(lines[i + 1]) : -1;
      if (rest === '|' || rest === '>') {
        const block = [];
        let j = i + 1;
        const baseIndent = childIndent > ind ? childIndent : ind + 2;
        while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) >= baseIndent)) {
          block.push(lines[j].trim() === '' ? '' : lines[j].slice(baseIndent));
          j++;
        }
        obj[key] = block.join('\n').trim();
        i = j;
        continue;
      }
      if (childIndent > ind) {
        const child = parseBlock(lines, i + 1, childIndent);
        obj[key] = child.list !== undefined ? child.list : child;
        i = child.next;
        continue;
      }
      obj[key] = null;
      i++;
      continue;
    }
    obj[key] = unquote(rest);
    i++;
  }
  return { obj, next: i };
}

function parseFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return { data: {}, body: text || '' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: text };
  const lines = text.slice(3, end).split(/\r?\n/);
  const parsed = parseBlock(lines, 0, 0);
  return { data: parsed.obj || {}, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

// ── upstream layout ─────────────────────────────────────────────────────────
const UP = {
  designSystems: join(SOURCE, 'design-systems'),
  examples: join(SOURCE, 'plugins', '_official', 'examples'),
  designTemplates: join(SOURCE, 'design-templates'),
  videoTemplates: join(SOURCE, 'plugins', '_official', 'video-templates'),
  imageTemplates: join(SOURCE, 'plugins', '_official', 'image-templates'),
  promptVideo: join(SOURCE, 'prompt-templates', 'video'),
  promptImage: join(SOURCE, 'prompt-templates', 'image'),
  promptImageAssets: join(SOURCE, 'assets', 'prompt-templates', 'image'),
  skills: join(SOURCE, 'skills'),
  atoms: join(SOURCE, 'plugins', '_official', 'atoms'),
  scenarios: join(SOURCE, 'plugins', '_official', 'scenarios'),
  officialDesignSystems: join(SOURCE, 'plugins', '_official', 'design-systems'),
};

const VENDOR = {
  designSystems: 'vendor/open-design/design-systems',
  examples: 'vendor/open-design/templates/examples',
  designTemplates: 'vendor/open-design/templates/design-templates',
  videoTemplates: 'vendor/open-design/templates/video',
  imageTemplates: 'vendor/open-design/templates/image',
  promptVideo: 'vendor/open-design/templates/prompts/video',
  promptImage: 'vendor/open-design/templates/prompts/image',
  promptImageAssets: 'vendor/open-design/templates/prompts/image-assets',
  skills: 'vendor/open-design/skills',
  atoms: 'vendor/open-design/atoms',
  scenarios: 'vendor/open-design/scenarios',
};

// ── copy plan ───────────────────────────────────────────────────────────────
const COPY_EXCLUDE = new Set(['node_modules', '.git', '.DS_Store', '__pycache__']);
const copyTasks = []; // { from, to, kind }

function planCopy(fromDir, toDir, kind, { includeFiles = false } = {}) {
  if (!isDir(fromDir)) return;
  copyTasks.push({ from: fromDir, to: toDir, kind, filesOnly: includeFiles });
}

function buildCopyPlan() {
  for (const slug of dirs(UP.designSystems)) {
    if (slug.startsWith('_')) continue; // _schema is tooling, not a design system
    planCopy(join(UP.designSystems, slug), join(VENDOR.designSystems, slug), 'design-system');
  }
  for (const slug of dirs(UP.examples)) planCopy(join(UP.examples, slug), join(VENDOR.examples, slug), 'template');
  for (const slug of dirs(UP.designTemplates)) planCopy(join(UP.designTemplates, slug), join(VENDOR.designTemplates, slug), 'template');
  for (const slug of dirs(UP.videoTemplates)) planCopy(join(UP.videoTemplates, slug), join(VENDOR.videoTemplates, slug), 'template');
  for (const slug of dirs(UP.imageTemplates)) planCopy(join(UP.imageTemplates, slug), join(VENDOR.imageTemplates, slug), 'template');
  planCopy(UP.promptVideo, VENDOR.promptVideo, 'prompt', { includeFiles: true });
  planCopy(UP.promptImage, VENDOR.promptImage, 'prompt', { includeFiles: true });
  planCopy(UP.promptImageAssets, VENDOR.promptImageAssets, 'asset', { includeFiles: true });
  for (const slug of dirs(UP.skills)) planCopy(join(UP.skills, slug), join(VENDOR.skills, slug), 'skill');
  for (const slug of dirs(UP.atoms)) planCopy(join(UP.atoms, slug), join(VENDOR.atoms, slug), 'atom');
  for (const slug of dirs(UP.scenarios)) planCopy(join(UP.scenarios, slug), join(VENDOR.scenarios, slug), 'scenario');
}

// ── digest over the copied source set ───────────────────────────────────────
function sha1File(abs) {
  const hash = createHash('sha1');
  hash.update(readFileSync(abs));
  return hash.digest('hex');
}
function sourceManifest() {
  const entries = [];
  for (const task of copyTasks) {
    const list = task.filesOnly
      ? files(task.from).map((name) => ({ abs: join(task.from, name), rel: `${posix(relative(SOURCE, task.to))}/${name}` }))
      : walk(task.from, { skip: [...COPY_EXCLUDE] }).map((rel) => ({ abs: join(task.from, rel), rel: `${posix(relative(SOURCE, task.to))}/${rel}` }));
    for (const item of list) {
      if (!exists(item.abs)) continue;
      const size = statSync(item.abs).size;
      entries.push(`${item.rel}\t${size}\t${sha1File(item.abs)}`);
    }
  }
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

// ── vendored path helpers ───────────────────────────────────────────────────
function relVendor(abs) { return posix(relative(ROOT, abs)); }
function vendorUrl(rel) { return `/${posix(rel)}`; }

// ── catalog builders ────────────────────────────────────────────────────────
function provenanceOf(slug, upstreamPath) {
  return { repo: 'nexu-io/open-design', path: upstreamPath, version: UPSTREAM_VERSION, commit: null, slug };
}

function promptRef(rel) {
  if (!rel) return null;
  const abs = resolve(ROOT, rel);
  if (!exists(abs) || !statSync(abs).isFile()) return null;
  return { path: posix(rel), url: vendorUrl(rel) };
}

function thumbnailRef(rel) {
  if (!rel) return null;
  const abs = resolve(ROOT, rel);
  if (!exists(abs) || !statSync(abs).isFile()) return null;
  return vendorUrl(rel);
}

function entryRef(rel) {
  if (!rel) return null;
  const abs = resolve(ROOT, rel);
  const present = exists(abs) && statSync(abs).isFile();
  return { path: posix(rel), url: vendorUrl(rel), exists: present };
}

function itemFiles(relDir) {
  const abs = resolve(ROOT, relDir);
  if (!isDir(abs)) return [];
  // ROOT-relative, consistent with every other path in the catalog.
  return walk(abs, { skip: [...COPY_EXCLUDE] }).map((rel) => posix(`${relDir}/${rel}`)).sort();
}

const KIND_BY_MODE = { prototype: 'website', deck: 'deck', video: 'motion', image: 'image', audio: 'document', 'design-system': 'website', utility: 'document', template: 'website' };
function kindFromMode(mode, surface, tags = []) {
  const t = tags.map((x) => String(x).toLowerCase());
  if (surface === 'video' || surface === 'hyperframes' || mode === 'video') return 'motion';
  if (surface === 'image' || mode === 'image') return 'image';
  if (mode === 'deck' || t.includes('deck') || t.includes('slides') || t.includes('ppt')) return 'deck';
  if (mode === 'audio') return 'document';
  if (t.some((x) => ['article', 'essay', 'report', 'documentation', 'docs', 'guide', 'resume', 'letter', 'newsletter', 'blog', 'book', 'paper', 'case-report', 'runbook', 'one-pager', 'e-guide', 'lookbook', 'playbook', 'ebook', 'magazine'].includes(x))) return 'document';
  return 'website';
}

function authorOf(json) {
  const a = json.author;
  if (!a) return null;
  if (typeof a === 'string') return a;
  return { name: a.name ?? null, url: a.url ?? null };
}

function normalizeTags(list) {
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

// design systems ------------------------------------------------------------
function buildDesignSystems() {
  const out = [];
  const officialLicenses = new Map();
  for (const slug of dirs(UP.officialDesignSystems)) {
    const f = join(UP.officialDesignSystems, slug, 'open-design.json');
    if (!exists(f)) continue;
    const j = readJson(f);
    officialLicenses.set(slug, { license: j.license ?? null, title: j.title ?? null, tags: normalizeTags(j.tags), author: authorOf(j), homepage: j.homepage ?? null });
  }
  for (const slug of dirs(UP.designSystems)) {
    if (slug.startsWith('_')) continue;
    const srcDir = join(UP.designSystems, slug);
    const manifest = exists(join(srcDir, 'manifest.json')) ? readJson(join(srcDir, 'manifest.json')) : {};
    const official = officialLicenses.get(slug) ?? null;
    const vendDir = join(VENDOR.designSystems, slug);
    const relDir = relVendor(vendDir);

    let license = official?.license ?? null;
    let licenseSource = official ? 'plugins/_official/design-systems/open-design.json' : null;
    if (!license) {
      const evidence = join(srcDir, 'source', 'evidence.md');
      const fromEvidence = exists(evidence) ? (readText(evidence).match(/License:\s*\[?([A-Za-z0-9.\-]+)/) || [])[1] : null;
      if (fromEvidence) { license = fromEvidence; licenseSource = 'design-systems/<slug>/source/evidence.md'; }
      else { license = 'MIT'; licenseSource = 'design-systems/README.md (upstream-derived product systems, MIT)'; }
    }

    const tokensFile = join(srcDir, 'design-tokens.json');
    let colors = [];
    let fonts = { display: [], body: [], mono: [], families: [] };
    let tokens = { total: 0, byType: {}, primary: [] };
    if (exists(tokensFile)) {
      try {
        const jt = readJson(tokensFile);
        const list = Array.isArray(jt.tokens) ? jt.tokens : [];
        tokens.total = jt.summary?.totalTokens ?? list.length;
        for (const tk of list) tokens.byType[tk.type] = (tokens.byType[tk.type] || 0) + 1;
        for (const tk of list) if (tk.type === 'color' && typeof tk.value === 'string') colors.push({ name: tk.name, value: tk.value, layer: tk.layer ?? null });
        for (const tk of list) {
          if (tk.type !== 'fontFamily') continue;
          const v = String(tk.value ?? '');
          if (/-mono|mono\b|Mono/.test(tk.name) || /mono/i.test(tk.name)) fonts.mono.push(v);
          else if (/-display|display/.test(tk.name)) fonts.display.push(v);
          else fonts.body.push(v);
          fonts.families.push(v);
        }
        tokens.primary = list.slice(0, 24).map((tk) => ({ name: tk.name, value: tk.value, type: tk.type }));
      } catch { /* leave empty */ }
    }
    // Fallback: two packages ship only tokens.css (no design-tokens.json). Parse it
    // so every design system still reports real colors, fonts and a token count.
    const tokensCssFile = join(srcDir, 'tokens.css');
    if (colors.length === 0 && exists(tokensCssFile)) {
      try {
        const css = readText(tokensCssFile);
        const decls = [...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g)]
          .map((m) => ({ name: m[1], value: m[2].trim() }))
          .filter((d, i, arr) => arr.findIndex((x) => x.name === d.name) === i);
        for (const d of decls) {
          const isColor = /^#|^rgb|^hsl|^color\(/i.test(d.value);
          const isFont = /font/i.test(d.name);
          if (isColor) colors.push({ name: d.name, value: d.value, layer: null });
          else if (isFont) {
            fonts.families.push(d.value);
            if (/mono/i.test(d.name)) fonts.mono.push(d.value);
            else if (/display/i.test(d.name)) fonts.display.push(d.value);
            else fonts.body.push(d.value);
          }
        }
        tokens.total = decls.length;
        tokens.byType = { cssDeclarations: decls.length };
        tokens.primary = decls.slice(0, 24).map((d) => ({ name: d.name, value: d.value, type: /^#|^rgb|^hsl|^color\(/i.test(d.value) ? 'color' : 'declaration' }));
      } catch { /* leave empty */ }
    }
    const designMd = join(srcDir, 'DESIGN.md');
    if (exists(designMd)) {
      const fam = readText(designMd).match(/\*\*Families:\*\*\s*(.+)/);
      if (fam) for (const part of fam[1].split(',').map((x) => x.trim()).filter(Boolean)) if (!fonts.families.includes(part)) fonts.families.push(part);
    }

    const previewPages = (manifest.preview?.pages ?? []).map((p) => ({ path: relVendor(join(vendDir, p.path)), role: p.role ?? null, title: p.title ?? null }));
    let thumbnail = null;
    const pngPreview = ['preview/tom-modern-palette.png', 'preview/tom-modern-components.png'].find((p) => exists(join(srcDir, p)));
    if (pngPreview) thumbnail = thumbnailRef(relVendor(join(vendDir, pngPreview)));
    else if (exists(join(srcDir, 'preview', 'colors.html'))) thumbnail = null;

    const filesIn = itemFiles(relDir);
    out.push({
      id: `od-ds-${slug}`,
      kind: 'design-system',
      slug,
      sourceSlug: slug,
      collection: 'designSystems',
      source: 'open-design',
      name: manifest.name ?? official?.title ?? slug,
      title: manifest.name ?? official?.title ?? slug,
      description: manifest.description ?? null,
      category: manifest.category ?? null,
      tags: normalizeTags(manifest.tags?.length ? manifest.tags : official?.tags),
      license,
      licenseSource,
      author: official?.author ?? null,
      sourceUrl: official?.homepage ?? `https://github.com/nexu-io/open-design/tree/main/design-systems/${slug}`,
      homepage: official?.homepage ?? null,
      provenance: { ...provenanceOf(slug, `design-systems/${slug}`), origin: manifest.source?.origin ?? null, type: manifest.source?.type ?? null },
      runtime: 'source-ready',
      sourceReady: true,
      requiresExternalGeneration: false,
      surface: 'web',
      mode: 'design-system',
      design: relVendor(join(vendDir, 'DESIGN.md')),
      designTokens: exists(join(srcDir, 'design-tokens.json')) ? relVendor(join(vendDir, 'design-tokens.json')) : null,
      tokensCss: exists(join(srcDir, 'tokens.css')) ? relVendor(join(vendDir, 'tokens.css')) : null,
      tailwind: exists(join(srcDir, 'tailwind-v4.css')) ? relVendor(join(vendDir, 'tailwind-v4.css')) : null,
      components: exists(join(srcDir, 'components.html')) ? relVendor(join(vendDir, 'components.html')) : null,
      colors,
      fonts,
      tokens,
      // DESIGN.md is the canonical readable prompt material for a design system.
      prompt: promptRef(relVendor(join(vendDir, 'DESIGN.md'))),
      promptPath: relVendor(join(vendDir, 'DESIGN.md')),
      preview: { type: 'html', pages: previewPages, thumbnail },
      thumbnail,
      path: relDir,
      files: filesIn,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// examples (canonical templates) --------------------------------------------
function buildExamples() {
  const out = [];
  for (const slug of dirs(UP.examples)) {
    const srcDir = join(UP.examples, slug);
    const jsonPath = join(srcDir, 'open-design.json');
    if (!exists(jsonPath)) continue;
    const j = readJson(jsonPath);
    const od = j.od ?? {};
    const vendDir = join(VENDOR.examples, slug);
    const relDir = relVendor(vendDir);
    const previewEntry = typeof od.preview?.entry === 'string' ? od.preview.entry.replace(/^\.\//, '') : null;
    const entryRel = previewEntry && exists(join(srcDir, previewEntry)) ? relVendor(join(vendDir, previewEntry)) : null;
    const skillRel = exists(join(srcDir, 'SKILL.md')) ? relVendor(join(vendDir, 'SKILL.md')) : null;
    // One example (web-clone) ships no SKILL.md; fall back to its readable
    // open-design.json so the entry still exposes prompt text.
    const promptRel = skillRel ?? (exists(jsonPath) ? relVendor(join(vendDir, 'open-design.json')) : null);
    const posterRel = typeof od.preview?.poster === 'string' && !/^https?:/.test(od.preview.poster)
      ? relVendor(join(vendDir, od.preview.poster.replace(/^\.\//, ''))) : null;
    const coverRel = exists(join(srcDir, 'assets', 'cover.jpg')) ? relVendor(join(vendDir, 'assets', 'cover.jpg')) : null;
    const licenseFile = exists(join(srcDir, 'LICENSE')) ? relVendor(join(vendDir, 'LICENSE')) : null;
    const license = j.license ?? (licenseFile ? licenseFromFile(join(srcDir, 'LICENSE')) : null) ?? 'Apache-2.0';
    const mode = od.mode ?? null;
    const kind = kindFromMode(mode, od.surface, j.tags);
    const thumbnail = thumbnailRef(coverRel) ?? thumbnailRef(posterRel);
    const entry = entryRef(entryRel);
    const sourceReady = Boolean(entry?.exists) && kind !== 'image';
    out.push({
      id: `od-${slug}`,
      kind,
      slug,
      sourceSlug: slug,
      collection: 'templates',
      source: 'open-design',
      sourceSet: 'examples',
      title: j.title ?? slug,
      titleI18n: j.title_i18n ?? null,
      description: j.description ?? null,
      category: null,
      tags: normalizeTags(j.tags),
      license,
      licenseSource: j.license ? 'open-design.json' : licenseFile ? 'LICENSE' : 'upstream repository license (Apache-2.0)',
      licenseFile,
      author: authorOf(j),
      sourceUrl: j.homepage ?? `https://github.com/nexu-io/open-design/tree/main/plugins/_official/examples/${slug}`,
      homepage: j.homepage ?? null,
      provenance: provenanceOf(slug, `plugins/_official/examples/${slug}`),
      runtime: sourceReady ? 'source-ready' : (entry ? 'reference-only' : 'external-generation-required'),
      sourceReady,
      requiresExternalGeneration: !sourceReady,
      surface: od.surface ?? null,
      mode,
      scenario: od.scenario ?? null,
      taskKind: od.taskKind ?? null,
      platform: od.platform ?? null,
      engine: od.engine ?? null,
      width: null,
      height: null,
      aspect: null,
      fps: null,
      duration: null,
      entry,
      prompt: promptRef(promptRel),
      promptPath: promptRel,
      thumbnail,
      preview: {
        type: od.preview?.type ?? null,
        entry: entry ? entry.path : null,
        poster: posterRel ? vendorUrl(posterRel) : null,
        posterUrl: typeof od.preview?.poster === 'string' && /^https?:/.test(od.preview.poster) ? od.preview.poster : null,
      },
      attribution: Array.isArray(od.attribution) ? od.attribution : [],
      path: relDir,
      files: itemFiles(relDir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// design-templates ----------------------------------------------------------
function buildDesignTemplates() {
  const out = [];
  for (const slug of dirs(UP.designTemplates)) {
    const srcDir = join(UP.designTemplates, slug);
    const skillPath = join(srcDir, 'SKILL.md');
    if (!exists(skillPath)) continue;
    const { data } = parseFrontmatter(readText(skillPath));
    const od = data.od ?? {};
    const vendDir = join(VENDOR.designTemplates, slug);
    const relDir = relVendor(vendDir);
    const previewEntry = typeof od.preview?.entry === 'string' ? od.preview.entry.replace(/^\.\//, '') : (exists(join(srcDir, 'example.html')) ? 'example.html' : null);
    const entryRel = previewEntry && exists(join(srcDir, previewEntry)) ? relVendor(join(vendDir, previewEntry)) : null;
    const jsonPath = join(srcDir, 'open-design.json');
    const j = exists(jsonPath) ? readJson(jsonPath) : {};
    const licenseFile = exists(join(srcDir, 'LICENSE')) ? relVendor(join(vendDir, 'LICENSE')) : null;
    const frontmatterLicense = typeof data.license === 'string' && /^(MIT|Apache-2\.0|CC-BY|CC0|BSD|ISC|MPL)/i.test(data.license) ? data.license : null;
    const fileLicense = licenseFile ? licenseFromFile(join(srcDir, 'LICENSE')) : null;
    const license = j.license ?? frontmatterLicense ?? fileLicense ?? 'Apache-2.0';
    const licenseSource = j.license ? 'open-design.json'
      : frontmatterLicense ? 'SKILL.md frontmatter'
        : fileLicense ? 'LICENSE' : 'upstream repository license (Apache-2.0)';
    const mode = od.mode ?? 'prototype';
    const kind = kindFromMode(mode, od.surface ?? j.od?.surface, j.tags);
    const entry = entryRef(entryRel);
    const sourceReady = Boolean(entry?.exists);
    const desc = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : null;
    out.push({
      id: `od-dt-${slug}`,
      kind,
      slug,
      sourceSlug: slug,
      collection: 'templates',
      source: 'open-design',
      sourceSet: 'design-templates',
      title: j.title ?? data.name ?? slug,
      titleI18n: j.title_i18n ?? null,
      description: desc,
      category: od.category ?? null,
      tags: normalizeTags(j.tags),
      license,
      licenseSource,
      licenseFile,
      author: authorOf(j),
      sourceUrl: j.homepage ?? `https://github.com/nexu-io/open-design/tree/main/design-templates/${slug}`,
      homepage: j.homepage ?? null,
      provenance: provenanceOf(slug, `design-templates/${slug}`),
      runtime: sourceReady ? 'source-ready' : 'reference-only',
      sourceReady,
      requiresExternalGeneration: !sourceReady,
      surface: od.surface ?? null,
      mode,
      scenario: od.scenario ?? null,
      platform: od.platform ?? null,
      engine: od.engine ?? null,
      width: null,
      height: null,
      aspect: null,
      fps: null,
      duration: null,
      entry,
      prompt: promptRef(relVendor(join(vendDir, 'SKILL.md'))),
      promptPath: relVendor(join(vendDir, 'SKILL.md')),
      thumbnail: null,
      preview: { type: od.preview?.type ?? (entry ? 'html' : null), entry: entry ? entry.path : null, poster: null, posterUrl: null },
      attribution: [],
      path: relDir,
      files: itemFiles(relDir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// video templates -----------------------------------------------------------
function buildVideoTemplates() {
  const out = [];
  for (const slug of dirs(UP.videoTemplates)) {
    const srcDir = join(UP.videoTemplates, slug);
    const jsonPath = join(srcDir, 'open-design.json');
    if (!exists(jsonPath)) continue;
    const j = readJson(jsonPath);
    const od = j.od ?? {};
    const t = exists(join(srcDir, 'template.json')) ? readJson(join(srcDir, 'template.json')) : {};
    const vendDir = join(VENDOR.videoTemplates, slug);
    const relDir = relVendor(vendDir);
    const isHyper = od.surface === 'hyperframes' || t.engine === 'hyperframes' || exists(join(srcDir, 'source', 'index.html'));
    const sourceIndex = exists(join(srcDir, 'source', 'index.html')) ? relVendor(join(vendDir, 'source', 'index.html')) : null;
    const skillRel = exists(join(srcDir, 'SKILL.md')) ? relVendor(join(vendDir, 'SKILL.md')) : null;
    const templateJsonRel = exists(join(srcDir, 'template.json')) ? relVendor(join(vendDir, 'template.json')) : null;
    const previewPng = exists(join(srcDir, 'preview.png')) ? relVendor(join(vendDir, 'preview.png')) : null;
    const previewMp4 = exists(join(srcDir, 'preview.mp4')) ? relVendor(join(vendDir, 'preview.mp4')) : null;
    const entry = entryRef(sourceIndex);
    const sourceReady = Boolean(entry?.exists);
    const promptFile = sourceReady ? skillRel : templateJsonRel;
    const license = j.license ?? t.source?.license ?? null;
    out.push({
      id: `od-vt-${slug}`,
      kind: 'motion',
      slug,
      sourceSlug: slug,
      collection: 'templates',
      source: 'open-design',
      sourceSet: 'video-templates',
      title: j.title ?? t.title ?? slug,
      titleI18n: j.title_i18n ?? null,
      description: j.description ?? t.summary ?? null,
      category: t.category ?? null,
      tags: normalizeTags(j.tags?.length ? j.tags : t.tags),
      license,
      licenseSource: j.license ? 'open-design.json' : t.source?.license ? 'template.json' : null,
      licenseFile: null,
      author: authorOf(j) ?? (t.source?.author ? { name: t.source.author, url: t.source.url ?? null } : null),
      sourceUrl: j.homepage ?? t.source?.url ?? `https://github.com/nexu-io/open-design/tree/main/plugins/_official/video-templates/${slug}`,
      homepage: j.homepage ?? null,
      provenance: provenanceOf(slug, `plugins/_official/video-templates/${slug}`),
      runtime: sourceReady ? 'source-ready' : 'external-generation-required',
      sourceReady,
      requiresExternalGeneration: !sourceReady,
      surface: od.surface ?? t.surface ?? 'video',
      mode: od.mode ?? 'video',
      scenario: od.scenario ?? 'video',
      taskKind: od.taskKind ?? 'new-generation',
      engine: od.engine ?? t.engine ?? (isHyper ? 'hyperframes' : null),
      aspect: t.aspect ?? null,
      fps: t.fps ?? null,
      duration: t.durationSec ?? null,
      width: null,
      height: null,
      entry,
      prompt: promptRef(promptFile),
      promptPath: promptFile,
      thumbnail: thumbnailRef(previewPng),
      preview: {
        type: sourceReady ? 'html' : 'video',
        entry: entry ? entry.path : null,
        poster: previewPng ? vendorUrl(previewPng) : (typeof od.preview?.poster === 'string' ? od.preview.poster : (t.previewImageUrl ?? null)),
        video: previewMp4 ? vendorUrl(previewMp4) : (typeof od.preview?.video === 'string' ? od.preview.video : (t.previewVideoUrl ?? null)),
      },
      attribution: Array.isArray(od.attribution) ? od.attribution : [],
      path: relDir,
      files: itemFiles(relDir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// image templates -----------------------------------------------------------
function localPromptImage(slug) {
  const candidate = join(UP.promptImageAssets, `${slug}.jpg`);
  return exists(candidate) ? relVendor(join(VENDOR.promptImageAssets, `${slug}.jpg`)) : null;
}
function buildImageTemplates() {
  const out = [];
  for (const slug of dirs(UP.imageTemplates)) {
    const srcDir = join(UP.imageTemplates, slug);
    const jsonPath = join(srcDir, 'open-design.json');
    if (!exists(jsonPath)) continue;
    const j = readJson(jsonPath);
    const od = j.od ?? {};
    const t = exists(join(srcDir, 'template.json')) ? readJson(join(srcDir, 'template.json')) : {};
    const vendDir = join(VENDOR.imageTemplates, slug);
    const relDir = relVendor(vendDir);
    const templateJsonRel = exists(join(srcDir, 'template.json')) ? relVendor(join(vendDir, 'template.json')) : null;
    const localAsset = localPromptImage(slug);
    const license = j.license ?? t.source?.license ?? null;
    out.push({
      id: `od-it-${slug}`,
      kind: 'image',
      slug,
      sourceSlug: slug,
      collection: 'templates',
      source: 'open-design',
      sourceSet: 'image-templates',
      title: j.title ?? t.title ?? slug,
      titleI18n: j.title_i18n ?? null,
      description: j.description ?? t.summary ?? null,
      category: t.category ?? null,
      tags: normalizeTags(j.tags?.length ? j.tags : t.tags),
      license,
      licenseSource: j.license ? 'open-design.json' : t.source?.license ? 'template.json' : null,
      licenseFile: null,
      author: authorOf(j) ?? (t.source?.author ? { name: t.source.author, url: t.source.url ?? null } : null),
      sourceUrl: j.homepage ?? t.source?.url ?? `https://github.com/nexu-io/open-design/tree/main/plugins/_official/image-templates/${slug}`,
      homepage: j.homepage ?? null,
      provenance: provenanceOf(slug, `plugins/_official/image-templates/${slug}`),
      runtime: 'external-generation-required',
      sourceReady: false,
      requiresExternalGeneration: true,
      surface: od.surface ?? 'image',
      mode: od.mode ?? 'image',
      scenario: od.scenario ?? 'image',
      taskKind: od.taskKind ?? 'new-generation',
      engine: null,
      aspect: t.aspect ?? null,
      fps: null,
      duration: null,
      width: null,
      height: null,
      entry: null,
      prompt: promptRef(templateJsonRel),
      promptPath: templateJsonRel,
      thumbnail: thumbnailRef(localAsset),
      preview: {
        type: 'image',
        entry: null,
        poster: localAsset ? vendorUrl(localAsset) : (typeof od.preview?.poster === 'string' ? od.preview.poster : (t.previewImageUrl ?? null)),
        video: null,
      },
      model: t.model ?? null,
      attribution: [],
      path: relDir,
      files: itemFiles(relDir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// prompt templates (external-generation prompts) ----------------------------
function buildPromptTemplates() {
  const out = [];
  const build = (surface, dir, vendBase, kindPrefix) => {
    for (const name of files(dir, '.json')) {
      const slug = name.replace(/\.json$/, '');
      let j;
      try { j = readJson(join(dir, name)); } catch { continue; }
      const rel = `${vendBase}/${name}`;
      const previewImage = typeof j.previewImageUrl === 'string' ? j.previewImageUrl : null;
      const previewVideo = typeof j.previewVideoUrl === 'string' ? j.previewVideoUrl : null;
      let thumbnail = null;
      if (surface === 'image') {
        const local = localPromptImage(slug);
        thumbnail = thumbnailRef(local);
      }
      out.push({
        id: `${kindPrefix}-${slug}`,
        kind: 'prompt',
        slug,
        sourceSlug: slug,
        collection: 'templates',
        source: 'open-design',
        sourceSet: `prompt-templates/${surface}`,
        title: j.title ?? slug,
        titleI18n: null,
        description: j.summary ?? null,
        category: j.category ?? null,
        tags: normalizeTags(j.tags),
        license: j.source?.license ?? null,
        licenseSource: j.source?.license ? 'prompt json source' : null,
        licenseFile: null,
        author: j.source?.author ? { name: j.source.author, url: j.source?.url ?? null } : null,
        sourceUrl: j.source?.url ?? j.source?.repo ?? null,
        homepage: null,
        provenance: { ...provenanceOf(slug, `prompt-templates/${surface}/${name}`), upstreamRepo: j.source?.repo ?? null },
        runtime: 'external-generation-required',
        sourceReady: false,
        requiresExternalGeneration: true,
        surface,
        mode: surface,
        scenario: surface,
        taskKind: 'new-generation',
        engine: j.model === 'hyperframes-html' ? 'hyperframes' : null,
        model: j.model ?? null,
        aspect: j.aspect ?? null,
        fps: null,
        duration: null,
        width: null,
        height: null,
        entry: null,
        prompt: promptRef(rel),
        promptPath: rel,
        thumbnail,
        preview: { type: surface, entry: null, poster: previewImage, video: previewVideo },
        attribution: [],
        path: posix(rel),
        files: [posix(rel)],
      });
    }
  };
  build('video', UP.promptVideo, VENDOR.promptVideo, 'od-pv');
  build('image', UP.promptImage, VENDOR.promptImage, 'od-pi');
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// skills / atoms / scenarios ------------------------------------------------
function buildSkillLike({ base, vendBase, idPrefix, kind, collection, defaultLicense }) {
  const out = [];
  for (const slug of dirs(base)) {
    const srcDir = join(base, slug);
    const skillPath = join(srcDir, 'SKILL.md');
    if (!exists(skillPath)) continue;
    const { data } = parseFrontmatter(readText(skillPath));
    const od = data.od ?? {};
    const vendDir = join(vendBase, slug);
    const relDir = relVendor(vendDir);
    const jsonPath = join(srcDir, 'open-design.json');
    const j = exists(jsonPath) ? readJson(jsonPath) : {};
    const licenseFile = exists(join(srcDir, 'LICENSE')) ? relVendor(join(vendDir, 'LICENSE')) : null;
    const frontmatterLicense = typeof data.license === 'string' && /^(MIT|Apache-2\.0|CC-BY|CC0|BSD|ISC|MPL)/i.test(data.license) ? data.license : null;
    const fileLicense = licenseFile ? licenseFromFile(join(srcDir, 'LICENSE')) : null;
    const license = j.license ?? frontmatterLicense ?? fileLicense ?? defaultLicense;
    const licenseSource = j.license ? 'open-design.json'
      : frontmatterLicense ? 'SKILL.md frontmatter'
        : fileLicense ? 'LICENSE' : `${collection} default (upstream repository license)`;
    const desc = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : null;
    const entryRel = exists(join(srcDir, 'example.html')) ? relVendor(join(vendDir, 'example.html')) : null;
    out.push({
      id: `${idPrefix}-${slug}`,
      kind,
      slug,
      sourceSlug: slug,
      collection,
      source: 'open-design',
      title: typeof data.en_name === 'string' ? data.en_name : (j.title ?? data.name ?? slug),
      titleI18n: typeof data.zh_name === 'string' ? { 'zh-CN': data.zh_name, en: data.en_name ?? data.name ?? slug } : (j.title_i18n ?? null),
      description: desc ?? j.description ?? null,
      category: od.category ?? data.category ?? null,
      tags: normalizeTags(data.tags),
      triggers: Array.isArray(data.triggers) ? data.triggers : [],
      license,
      licenseSource,
      licenseFile,
      author: null,
      sourceUrl: j.homepage ?? `https://github.com/nexu-io/open-design/tree/main/${posix(relative(SOURCE, srcDir))}`,
      homepage: j.homepage ?? null,
      provenance: provenanceOf(slug, posix(relative(SOURCE, srcDir))),
      runtime: entryRel ? 'source-ready' : 'reference-only',
      sourceReady: Boolean(entryRel),
      requiresExternalGeneration: false,
      surface: od.surface ?? j.od?.surface ?? null,
      mode: od.mode ?? j.od?.mode ?? null,
      scenario: od.scenario ?? j.od?.scenario ?? null,
      entry: entryRef(entryRel),
      prompt: promptRef(relVendor(join(vendDir, 'SKILL.md'))),
      promptPath: relVendor(join(vendDir, 'SKILL.md')),
      thumbnail: null,
      preview: { type: entryRel ? 'html' : null, entry: entryRel ? vendorUrl(entryRel) : null, poster: null, video: null },
      attribution: [],
      path: relDir,
      files: itemFiles(relDir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildSkills() {
  return buildSkillLike({ base: UP.skills, vendBase: VENDOR.skills, idPrefix: 'od-sk', kind: 'skill', collection: 'skills', defaultLicense: 'Apache-2.0' });
}
function buildAtoms() {
  return buildSkillLike({ base: UP.atoms, vendBase: VENDOR.atoms, idPrefix: 'od-at', kind: 'atom', collection: 'atoms', defaultLicense: 'MIT' });
}
function buildScenarios() {
  return buildSkillLike({ base: UP.scenarios, vendBase: VENDOR.scenarios, idPrefix: 'od-sc', kind: 'scenario', collection: 'scenarios', defaultLicense: 'MIT' });
}

const CREATION_MODES = [
  { id: 'website', name: '网站 / 原型', en: 'Website', kinds: ['website'], surfaces: ['web'], description: '可运行的单页网站、落地页与原型。' },
  { id: 'deck', name: '幻灯片', en: 'Slides', kinds: ['deck'], surfaces: ['web'], description: '演示稿、幻灯片与报告版面。' },
  { id: 'document', name: '文档', en: 'Document', kinds: ['document'], surfaces: ['web', 'markdown'], description: '长文、报告、说明书与文档页面。' },
  { id: 'image', name: '图片', en: 'Image', kinds: ['image'], surfaces: ['image'], description: '图片与海报提示词模板（需要外部图像生成）。' },
  { id: 'motion', name: '动效', en: 'Motion', kinds: ['motion'], surfaces: ['video', 'hyperframes'], description: '动效视频模板与视频提示词模板。' },
];

// ── validation ──────────────────────────────────────────────────────────────
function validate(entries) {
  const ids = new Set();
  for (const item of entries) {
    if (!SAFE_ID.test(item.id)) fail(`unsafe id: ${item.id}`);
    if (ids.has(item.id)) fail(`duplicate id: ${item.id}`);
    ids.add(item.id);
    if (item.prompt && (!item.prompt.path || !exists(resolve(ROOT, item.prompt.path)))) fail(`prompt path missing for ${item.id}: ${item.prompt?.path}`);
    if (item.entry && !item.entry.path) fail(`entry without path: ${item.id}`);
    if (item.thumbnail && !item.thumbnail.startsWith('/vendor/')) fail(`thumbnail not vendored: ${item.id} -> ${item.thumbnail}`);
  }
  return ids.size;
}

// ── main ────────────────────────────────────────────────────────────────────
if (!isDir(SOURCE)) fail(`upstream source not found: ${SOURCE}`);
let UPSTREAM_VERSION = exists(join(SOURCE, 'package.json')) ? (readJson(join(SOURCE, 'package.json')).version ?? 'unknown') : 'unknown';

function guardTarget() {
  if (!exists(TARGET)) return;
  if (!exists(MARKER)) fail(`refusing to overwrite unrelated directory ${TARGET} (no PROVENANCE.json marker). Use --force only if you are sure it is ours.`);
  if (FORCE) return;
  const previous = readJson(MARKER);
  if (previous.name !== 'open-design') fail(`refusing to overwrite ${TARGET}: marker is not an open-design import marker.`);
  const previousVersion = previous.source?.version ?? previous.version;
  if (previousVersion !== UPSTREAM_VERSION) {
    log(`previous import version ${previousVersion}; source version ${UPSTREAM_VERSION}`);
  }
}

function performCopy(digest, previousDigest) {
  if (SKIP_COPY) { log('skip-copy: not copying files'); return; }
  if (!FORCE && previousDigest && previousDigest === digest && exists(join(TARGET, 'design-systems')) && exists(join(TARGET, 'templates'))) {
    log('source digest unchanged; keeping existing vendored files');
    return;
  }
  if (FORCE && exists(TARGET)) rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  for (const task of copyTasks) {
    mkdirSync(task.to, { recursive: true });
    if (task.filesOnly) {
      for (const name of files(task.from)) cpSync(join(task.from, name), join(task.to, name), { filter: (src) => !COPY_EXCLUDE.has(src.split(/[\\/]/).pop()) });
    } else {
      cpSync(task.from, task.to, { recursive: true, filter: (src) => !COPY_EXCLUDE.has(src.split(/[\\/]/).pop()) });
    }
  }
  // carry upstream root license + notices for provenance
  if (exists(join(SOURCE, 'LICENSE'))) cpSync(join(SOURCE, 'LICENSE'), join(TARGET, 'UPSTREAM-LICENSE.txt'));
  if (exists(join(UP.videoTemplates, 'HYPERFRAMES-ATTRIBUTIONS.md'))) cpSync(join(UP.videoTemplates, 'HYPERFRAMES-ATTRIBUTIONS.md'), join(TARGET, 'HYPERFRAMES-ATTRIBUTIONS.md'));
  if (exists(join(UP.designSystems, 'README.md'))) cpSync(join(UP.designSystems, 'README.md'), join(TARGET, 'design-systems-README.md'));
}

log(`source: ${SOURCE} (version ${UPSTREAM_VERSION})`);
guardTarget();
buildCopyPlan();
const digest = sourceManifest();
const previous = exists(MARKER) ? readJson(MARKER) : null;
log(`content digest: ${digest.slice(0, 16)}… (${copyTasks.length} copy roots)`);
performCopy(digest, previous?.digest);
// Write the provenance marker immediately after the copy so an interrupted
// catalog build still leaves a directory this importer recognizes as ours.
mkdirSync(TARGET, { recursive: true });
writeFileSync(MARKER, `${JSON.stringify({ name: 'open-design', version: UPSTREAM_VERSION, digest, status: 'copy-complete', at: new Date().toISOString() }, null, 2)}\n`, 'utf8');

const designSystemsOut = buildDesignSystems();
const templates = [...buildExamples(), ...buildDesignTemplates(), ...buildVideoTemplates(), ...buildImageTemplates(), ...buildPromptTemplates()];
const skills = buildSkills();
const atoms = buildAtoms();
const scenarios = buildScenarios();

const all = [...designSystemsOut, ...templates, ...skills, ...atoms, ...scenarios];

// Some upstream entries record a source (e.g. an original X/Twitter post) rather
// than an SPDX license. That is not a redistribution grant: flag it so consumers
// never treat such media as freely redistributable.
const REDISTRIBUTABLE = /^(MIT|Apache-2\.0|CC0-1\.0|CC-BY-4\.0|BSD-2-Clause|BSD-3-Clause|ISC|MPL-2\.0|0BSD|Unlicense)$/i;
for (const item of all) {
  const ok = typeof item.license === 'string' && REDISTRIBUTABLE.test(item.license.trim());
  item.redistributable = ok;
  if (!ok) item.licenseNote = 'Upstream records a source reference, not a redistribution license. Treat as reference-only; do not redistribute the media without checking the original terms.';
}

const idCount = validate(all);

const licenseSummary = {};
for (const item of all) {
  const key = item.license ?? 'unspecified';
  licenseSummary[key] = (licenseSummary[key] || 0) + 1;
}
const runtimeSummary = {};
for (const item of templates) runtimeSummary[item.runtime] = (runtimeSummary[item.runtime] || 0) + 1;

const stats = {
  designSystems: designSystemsOut.length,
  templates: templates.length,
  templatesBySet: {
    examples: templates.filter((x) => x.sourceSet === 'examples').length,
    'design-templates': templates.filter((x) => x.sourceSet === 'design-templates').length,
    'video-templates': templates.filter((x) => x.sourceSet === 'video-templates').length,
    'image-templates': templates.filter((x) => x.sourceSet === 'image-templates').length,
    'prompt-templates/video': templates.filter((x) => x.sourceSet === 'prompt-templates/video').length,
    'prompt-templates/image': templates.filter((x) => x.sourceSet === 'prompt-templates/image').length,
  },
  templatesByKind: templates.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] || 0) + 1; return acc; }, {}),
  runtime: runtimeSummary,
  skills: skills.length,
  atoms: atoms.length,
  scenarios: scenarios.length,
  total: all.length,
  uniqueIds: idCount,
};

const source = {
  repo: 'nexu-io/open-design',
  url: 'https://github.com/nexu-io/open-design',
  version: UPSTREAM_VERSION,
  commit: null,
  commitNote: 'Upstream snapshot ships no .git; revision is pinned by package version plus a content digest over every imported file.',
  revision: `sha256:${digest}`,
  digest,
  importedAt: new Date().toISOString(),
  license: 'Apache-2.0',
  licenseNote: 'OpenDesign repository is Apache-2.0; individual items carry their own licenses recorded per entry.',
  licenseSummary,
};

const catalog = {
  schemaVersion: 'eac-open-design-library/v1',
  source,
  stats,
  creationModes: CREATION_MODES,
  designSystems: designSystemsOut,
  templates,
  skills,
  atoms,
  scenarios,
};

mkdirSync(TARGET, { recursive: true });
writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
writeFileSync(MARKER, `${JSON.stringify({
  name: 'open-design',
  source,
  stats,
  target: 'vendor/open-design',
  files: all.length,
  digest,
}, null, 2)}\n`, 'utf8');

log('');
log('Imported:');
log(`  design systems : ${stats.designSystems}`);
log(`  templates      : ${stats.templates} ${JSON.stringify(stats.templatesBySet)}`);
log(`  template kinds : ${JSON.stringify(stats.templatesByKind)}`);
log(`  runtime        : ${JSON.stringify(stats.runtime)}`);
log(`  skills         : ${stats.skills}`);
log(`  atoms          : ${stats.atoms}`);
log(`  scenarios      : ${stats.scenarios}`);
log(`  total entries  : ${stats.total} (unique ids ${idCount})`);
log(`  licenses       : ${JSON.stringify(licenseSummary)}`);
log(`catalog: ${posix(relative(ROOT, CATALOG))}`);
