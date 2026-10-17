const MAX_TIME = 3600;
const MAX_ROWS = 100_000;
const MAX_TEXT = 20_000;

function time(value, name, fallback) {
  value = value === undefined ? fallback : value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIME) {
    throw new TypeError(`${name} must be a finite number between 0 and ${MAX_TIME}`);
  }
  return value;
}

function interval(row, name) {
  if (!row || typeof row !== 'object') throw new TypeError(`${name} must be a timestamped object`);
  const start = time(row.start, `${name}.start`);
  const end = time(row.end, `${name}.end`);
  if (end <= start) throw new TypeError(`${name}.end must be greater than start`);
  if (typeof row.text !== 'string' || row.text.length > MAX_TEXT) {
    throw new TypeError(`${name}.text must be a string of at most ${MAX_TEXT} characters`);
  }
  return { start, end, text: row.text };
}

function rows(value, name) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) {
    throw new TypeError(`${name} must be an array of at most ${MAX_ROWS} rows`);
  }
  let characters = 0;
  return value.map((row, index) => {
    const result = interval(row, `${name}[${index}]`);
    characters += result.text.length;
    if (characters > 2_000_000) throw new RangeError(`${name} exceeds 2000000 text characters`);
    return result;
  });
}

const COLOR_NAMES = {
  white: '#ffffff', black: '#000000', transparent: '#00000000',
  red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
};

function assColor(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a CSS hex color`);
  const color = COLOR_NAMES[value.toLowerCase()] ?? value;
  if (!/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)) {
    throw new TypeError(`${name} must be a CSS hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)`);
  }
  let hex = color.slice(1);
  if (hex.length <= 4) hex = [...hex].map((char) => char + char).join('');
  const alpha = (255 - Number.parseInt(hex.slice(6) || 'ff', 16)).toString(16).padStart(2, '0');
  return `&H${alpha}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}

function styleOptions(value, height) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subtitleStyle must be an object');
  }
  const fontFamily = value.fontFamily ?? 'Microsoft YaHei';
  if (typeof fontFamily !== 'string' || !fontFamily.trim() || fontFamily.length > 128
    || /[,\\{}\u0000-\u001f\u007f]/u.test(fontFamily)) {
    throw new TypeError('subtitleStyle.fontFamily must be a font name without ASS delimiters or control characters');
  }
  const fontSize = value.fontSize ?? Math.max(8, Math.round(height * 0.05));
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 1 || fontSize > 512) {
    throw new TypeError('subtitleStyle.fontSize must be a finite number between 1 and 512');
  }
  const position = value.position ?? 'bottom';
  if (!['bottom', 'top'].includes(position)) throw new TypeError('subtitleStyle.position must be bottom or top');
  return {
    fontFamily: fontFamily.trim(), fontSize, alignment: position === 'top' ? 8 : 2,
    color: assColor(value.color ?? 'white', 'subtitleStyle.color'),
    background: value.background === undefined ? null : assColor(value.background, 'subtitleStyle.background'),
  };
}

function literalText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0085\u2028\u2029]/gu, '\n')
    .replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    // ASS has no general \\ escape: a zero-width word joiner prevents \N, \n, \h and \{.
    .replace(/\\/g, '\\\u2060').replace(/{/g, '\\{').replace(/}/g, '\\}')
    .replace(/\n/g, '\\N');
}

function timestamp(centiseconds) {
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const seconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

/** Internal renderer helper: validated UTF-8 ASS, or an empty string when no cues are visible. */
export function createCaptionScript({ captions = [], subtitleStyle, width, height, duration }) {
  const validated = rows(captions, 'captions');
  const style = styleOptions(subtitleStyle, height);
  const events = [];
  for (const row of validated) {
    // Round upwards to ASS's centisecond clock; never display a cue before its start.
    const start = Math.ceil(row.start * 100 - 1e-7);
    const end = Math.ceil(Math.min(row.end, duration) * 100 - 1e-7);
    if (end <= start || !row.text.trim()) continue;
    events.push(`Dialogue: 0,${timestamp(start)},${timestamp(end)},Default,,0,0,0,,${literalText(row.text)}`);
  }
  if (!events.length) return '';
  const marginX = Math.max(2, Math.round(width * 0.04));
  const marginY = Math.max(2, Math.round(height * 0.05));
  const outline = Math.max(1, Math.round(height / 360));
  const boxed = style.background && !style.background.startsWith('&HFF');
  const borderColor = boxed ? style.background : '&H00000000';
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.fontFamily},${style.fontSize},${style.color},${style.color},${borderColor},${style.background ?? '&HFF000000'},0,0,0,0,100,100,0,0,${boxed ? 3 : 1},${outline},0,${style.alignment},${marginX},${marginX},${marginY},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events, '',
  ].join('\n');
}

function alignedWords(segment) {
  const words = segment.words;
  if (!Array.isArray(words) || !words.length || words.length > 100_000) return null;
  let previous = segment.start;
  for (const word of words) {
    if (!word || typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < previous || word.end < word.start || word.end > segment.end
      || (word.start === word.end && /[\p{L}\p{N}]/u.test(word.word))) return null;
    previous = word.end;
  }
  const comparable = (text) => text.replace(/\s+/gu, '');
  if (comparable(words.map((word) => word.word).join('')) !== comparable(segment.text)) return null;
  // Locate exact substrings so partial cues preserve original punctuation and spacing.
  let cursor = 0;
  const aligned = [];
  for (const word of words) {
    const token = word.word.trim();
    if (!token) continue;
    while (/\s/u.test(segment.text[cursor] ?? '') && cursor < segment.text.length) cursor++;
    if (!segment.text.startsWith(token, cursor)) return null;
    aligned.push({ ...word, from: cursor, to: cursor + token.length });
    cursor += token.length;
  }
  return aligned;
}

/**
 * Map source transcript intervals through the selected asset's cuts, without mutation.
 * Missing/incomplete word alignment retains whole sentences within each intersection.
 */
export function remapTranscriptToTimeline({ segments, clips, assetId } = {}) {
  const validated = rows(segments, 'segments');
  if (!Array.isArray(clips) || clips.length > 128) throw new TypeError('clips must contain at most 128 clips');
  if (typeof assetId !== 'string' || !assetId.trim()) throw new TypeError('assetId must be a nonempty string');
  const selected = clips.filter((clip) => clip?.assetId === assetId && clip.kind !== 'image').map((clip) => {
    const start = time(clip.start, 'clip.start', 0);
    const sourceIn = time(clip.sourceIn, 'clip.sourceIn', 0);
    const duration = time(clip.duration, 'clip.duration');
    if (!duration || start + duration > MAX_TIME) throw new TypeError('clip duration must be positive and fit the timeline');
    return { start, sourceIn, duration };
  });
  const output = [];
  for (const [index, segment] of validated.entries()) {
    if (!segment.text.trim()) continue;
    const words = alignedWords({ ...segments[index], ...segment });
    const mapped = [];
    for (const clip of selected) {
      const start = Math.max(segment.start, clip.sourceIn);
      const end = Math.min(segment.end, clip.sourceIn + clip.duration);
      if (end <= start) continue;
      let text = segment.text;
      if (words) {
        const retained = words.filter((word) => word.end === word.start
          ? word.start > start && word.start <= end : word.start < end && word.end > start);
        if (!retained.length) continue;
        text = segment.text.slice(retained[0].from, retained.at(-1).to).trim();
      }
      if (!text.trim()) continue;
      mapped.push({
        start: Math.max(clip.start, clip.start + (start - clip.sourceIn)),
        end: Math.min(clip.start + clip.duration, clip.start + (end - clip.sourceIn)),
        text, sourceStart: start, sourceEnd: end,
      });
    }
    mapped.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const row of mapped) {
      const previous = merged.at(-1);
      const overlaps = previous && row.start < previous.end - 1e-9;
      const continuesSource = previous && row.sourceStart >= previous.sourceEnd - 1e-9;
      if (previous && previous.text === row.text && row.start <= previous.end + 1e-9
        && (overlaps || continuesSource)) {
        previous.end = Math.max(previous.end, row.end);
        previous.sourceEnd = Math.max(previous.sourceEnd, row.sourceEnd);
      } else merged.push({ ...row });
    }
    output.push(...merged.map(({ start, end, text }) => ({ start, end, text })));
    if (output.length > MAX_ROWS) throw new RangeError('Remapped captions exceed 100000 rows');
  }
  return output.sort((a, b) => a.start - b.start || a.end - b.end);
}
