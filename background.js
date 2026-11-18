// Service worker: the only place the API key is read and the only code that
// talks to api.anthropic.com. Nothing is sent anywhere unless the user clicks
// Summarize or sends a chat message.

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
// Models that accept the server-side refusal fallback parameter.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);

const INSTRUCTIONS =
  'You are helping someone with a YouTube video they are watching. The video\'s ' +
  'title, channel and full transcript follow; each transcript line starts with its ' +
  'timestamp in [m:ss] form. Base your answers on the transcript, and say so plainly ' +
  'when something is not covered in it. When you point to a moment in the video, ' +
  'cite its timestamp in square brackets, like [12:34], so the reader can jump to it. ' +
  'You may also be shown frames sampled across the whole video, arranged in grids with ' +
  'each frame\'s timestamp printed in its top-left corner, and sometimes the frame that ' +
  'is on screen right now. Use them for anything visual: what is shown, slides, charts, ' +
  'on-screen text, who appears. The sampled frames are small, so say when a detail is ' +
  'too small to make out instead of guessing. If there is no transcript, work from the ' +
  'frames alone and say that you are doing so. ' +
  'Write in Markdown using only headings, bullet lists and bold.';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  } else if (msg?.type === 'status') {
    chrome.storage.local.get(['apiKey']).then((s) => sendResponse({ hasKey: !!s.apiKey }));
    return true; // async response
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'claude') return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener((req) => {
    ask(req, abort.signal, (m) => {
      try { port.postMessage(m); } catch { /* panel went away */ }
    });
  });
});

async function ask(req, signal, send) {
  try {
    const { apiKey, model = DEFAULT_MODEL } = await chrome.storage.local.get(['apiKey', 'model']);
    if (!apiKey) {
      send({ type: 'error', code: 'no_key', message: 'Add your Claude API key in the extension settings first.' });
      return;
    }

    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      // Required because the request comes from a browser origin (the extension).
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const body = {
      model,
      max_tokens: 64000,
      stream: true,
      system: [
        { type: 'text', text: INSTRUCTIONS },
        // The transcript is identical across the summary and every chat turn,
        // so cache it: follow-up questions then cost a fraction of the first.
        { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } },
      ],
      messages: await withVideoFrames(req, send),
    };
    if (FALLBACK_MODELS.has(model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }

    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      send({ type: 'error', message: await describeHttpError(res) });
      return;
    }

    let stopReason = null;
    for await (const event of sseEvents(res.body)) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        send({ type: 'delta', text: event.delta.text });
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      } else if (event.type === 'error') {
        send({ type: 'error', message: event.error?.message || 'The Claude API reported an error.' });
        return;
      }
    }
    send({ type: 'done', stopReason });
  } catch (err) {
    if (signal.aborted) return;
    send({ type: 'error', message: 'Could not reach the Claude API: ' + (err?.message || err) });
  }
}

async function* sseEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
    }
  }
}

async function describeHttpError(res) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
  if (res.status === 401) return 'The Claude API rejected the key. Check it in the extension settings.';
  if (res.status === 429) return 'Rate limited by the Claude API. Wait a moment and try again. ' + detail;
  if (res.status === 529 || res.status >= 500) return 'The Claude API is overloaded or unavailable right now. Try again shortly.';
  return `Claude API error ${res.status}. ${detail}`.trim();
}

// ---------- "watching" the video ----------
//
// YouTube publishes storyboards for every video: sprite sheets of small frames
// taken at a fixed interval (the previews shown when hovering the seek bar).
// We sample frames evenly across the whole video, lay them out in labeled
// grids, and attach those grids to the first message of the conversation.

const MAX_FRAMES = 120;
const GRID_COLS = 6;
const GRID_ROWS = 5;
const TILE_W = 240;
const TILE_H = 135;

const gridCache = new Map(); // videoId -> Promise<grids>

async function withVideoFrames(req, send) {
  const messages = req.messages.map((m) => ({ ...m }));
  if (!req.visual?.spec) return messages;
  let grids = [];
  try {
    if (!gridCache.has(req.visual.videoId)) {
      if (gridCache.size > 4) gridCache.clear();
      gridCache.set(req.visual.videoId, buildFrameGrids(req.visual.spec, req.visual.duration));
    }
    grids = await gridCache.get(req.visual.videoId);
  } catch (err) {
    gridCache.delete(req.visual.videoId);
    send({ type: 'notice', text: 'Could not load frames for this video, so this answer uses the transcript only.' });
    return messages;
  }
  if (!grids.length) return messages;

  const blocks = [{
    type: 'text',
    text: 'Frames sampled evenly across the whole video, in order. Each frame has its timestamp in the top-left corner.',
  }];
  for (const grid of grids) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: grid } });
  }
  // The frames are the same for every turn about this video, so cache them too.
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };

  const first = messages[0];
  const own = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
  messages[0] = { role: 'user', content: [...blocks, ...own] };
  return messages;
}

function parseStoryboard(spec, durationSec) {
  const parts = spec.split('|');
  const base = parts[0];
  const levels = parts.slice(1).map((part, index) => {
    const [w, h, count, cols, rows, intervalMs, name, sigh] = part.split('#');
    return { index, w: +w, h: +h, count: +count, cols: +cols, rows: +rows, intervalMs: +intervalMs, name, sigh };
  }).filter((l) => l.w && l.h && l.count && l.cols && l.rows);
  if (!levels.length) throw new Error('No storyboard levels');
  const level = levels.reduce((best, l) => (l.w > best.w ? l : best));
  // The lowest level has no fixed interval; its frames are spread over the video.
  const stepSec = level.intervalMs ? level.intervalMs / 1000 : durationSec / level.count;
  const sheetUrl = (n) =>
    base.split('$L').join(String(level.index)).split('$N').join(level.name.split('$M').join(String(n))) +
    '&sigh=' + level.sigh;
  return { level, stepSec, sheetUrl };
}

function stamp(sec) {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

async function buildFrameGrids(spec, durationSec) {
  const { level, stepSec, sheetUrl } = parseStoryboard(spec, durationSec);
  const perSheet = level.cols * level.rows;
  const wanted = Math.min(level.count, MAX_FRAMES);
  const picks = [...new Set(Array.from({ length: wanted }, (_, i) => Math.floor(((i + 0.5) * level.count) / wanted)))];

  const sheets = new Map();
  await Promise.all([...new Set(picks.map((k) => Math.floor(k / perSheet)))].map(async (n) => {
    const res = await fetch(sheetUrl(n));
    if (!res.ok) throw new Error(`Storyboard sheet ${n} returned ${res.status}`);
    sheets.set(n, await createImageBitmap(await res.blob()));
  }));

  const grids = [];
  const perGrid = GRID_COLS * GRID_ROWS;
  for (let start = 0; start < picks.length; start += perGrid) {
    const chunk = picks.slice(start, start + perGrid);
    const canvas = new OffscreenCanvas(GRID_COLS * TILE_W, Math.ceil(chunk.length / GRID_COLS) * TILE_H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 15px sans-serif';
    ctx.textBaseline = 'top';
    chunk.forEach((k, i) => {
      const pos = k % perSheet;
      const dx = (i % GRID_COLS) * TILE_W;
      const dy = Math.floor(i / GRID_COLS) * TILE_H;
      ctx.drawImage(sheets.get(Math.floor(k / perSheet)),
        (pos % level.cols) * level.w, Math.floor(pos / level.cols) * level.h, level.w, level.h,
        dx, dy, TILE_W, TILE_H);
      const label = stamp(k * stepSec);
      ctx.fillStyle = '#000';
      ctx.fillRect(dx, dy, ctx.measureText(label).width + 8, 19);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, dx + 4, dy + 3);
    });
    grids.push(await toBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })));
  }
  for (const bitmap of sheets.values()) bitmap.close();
  return grids;
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
