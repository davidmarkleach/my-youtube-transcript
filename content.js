// Content script: adds a Transcript / Summary / Chat panel to YouTube watch pages.
// Transcripts are fetched from youtube.com itself (same origin as the page), so
// reading, searching, copying and downloading a transcript involves no third party.

(() => {
  if (window.__mytLoaded) return;
  window.__mytLoaded = true;

  // YouTube's web-client caption URLs need a proof-of-origin token and return an
  // empty body without one; the Android client's caption URLs do not.
  const PLAYER_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };
  const SUMMARY_PROMPT =
    'Summarize this video. Start with a two or three sentence overview, then list the ' +
    'key points as bullets with a timestamp each, then finish with the main takeaways.';

  const ext = typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome : null;

  const state = {
    videoId: null,
    meta: null,
    tracks: [],
    track: null,
    segments: [],
    showTimes: true,
    activeIndex: -1,
    tab: 'transcript',
    collapsed: false,
    summary: '',
    chat: [],
    cancelStream: null,
    watch: true, // send video frames along with the transcript
    storyboard: null,
    duration: 0,
  };

  // ---------- small helpers ----------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  function parseTime(str) {
    return str.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  function mainVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  // The frame on screen right now, as a base64 JPEG (null during ads, for
  // DRM-protected video, or before the video has loaded).
  function captureFrame() {
    const video = mainVideo();
    if (!video?.videoWidth || document.querySelector('#movie_player.ad-showing')) return null;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return { data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], time: video.currentTime };
    } catch {
      return null;
    }
  }

  function seek(sec) {
    const video = mainVideo();
    if (video) {
      video.currentTime = sec;
      video.play?.().catch(() => {});
    }
  }

  function currentVideoId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  async function getPref(keys) {
    try { return ext ? await ext.storage.local.get(keys) : {}; } catch { return {}; }
  }
  function setPref(obj) {
    try { ext?.storage.local.set(obj); } catch { /* extension was reloaded */ }
  }

  // ---------- transcript fetching ----------

  async function fetchPlayer(videoId) {
    const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: PLAYER_CLIENT }, videoId }),
    });
    if (!res.ok) throw new Error(`YouTube returned ${res.status} for the video info request.`);
    return res.json();
  }

  async function fetchSegments(track) {
    const url = new URL(track.baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url);
    const text = res.ok ? await res.text() : '';
    if (!text) throw new Error('YouTube returned an empty caption file for this track.');
    const segments = [];
    for (const ev of JSON.parse(text).events || []) {
      if (!ev.segs) continue;
      const line = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (line) segments.push({ start: (ev.tStartMs || 0) / 1000, text: line });
    }
    return segments;
  }

  function trackLabel(t) {
    const name = t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode;
    return t.kind === 'asr' && !/auto/i.test(name) ? `${name} (auto-generated)` : name;
  }

  function pickTrack(tracks, preferredLang) {
    const manual = (lang) => tracks.find((t) => t.languageCode === lang && t.kind !== 'asr');
    const any = (lang) => tracks.find((t) => t.languageCode === lang);
    return (
      (preferredLang && (manual(preferredLang) || any(preferredLang))) ||
      manual('en') || any('en') ||
      tracks.find((t) => t.kind !== 'asr') || tracks[0]
    );
  }

  // Groups caption lines into ~30 second paragraphs, one timestamp each.
  function paragraphs(withTimes) {
    const out = [];
    let start = null;
    let buf = [];
    const flush = () => {
      if (buf.length) out.push((withTimes ? `[${fmtTime(start)}] ` : '') + buf.join(' '));
      buf = [];
    };
    for (const seg of state.segments) {
      if (start === null || seg.start - start >= 30) {
        flush();
        start = seg.start;
      }
      buf.push(seg.text);
    }
    flush();
    return out;
  }

  function transcriptText() {
    return state.showTimes
      ? state.segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n')
      : paragraphs(false).join('\n\n');
  }

  function aiContext() {
    const m = state.meta || {};
    const transcript = state.segments.length ? paragraphs(true).join('\n') : '(This video has no captions, so there is no transcript.)';
    return `Title: ${m.title || 'Unknown'}\nChannel: ${m.author || 'Unknown'}\n\nTranscript:\n${transcript}`;
  }

  // ---------- UI ----------

  const CSS = `
    :host { all: initial; display: block; margin-bottom: 16px; }
    .panel { --bg:#fff; --fg:#0f0f0f; --muted:#606060; --line:#0000001a; --soft:#0000000d; --accent:#065fd4;
      font: 14px/1.45 Roboto, system-ui, sans-serif; color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    .panel.dark { --bg:#0f0f0f; --fg:#f1f1f1; --muted:#aaa; --line:#ffffff26; --soft:#ffffff14; --accent:#3ea6ff; }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; background: var(--soft); border: 0; border-radius: 16px; padding: 5px 12px; }
    button:hover { filter: brightness(0.92); }
    .panel.dark button:hover { filter: brightness(1.4); }
    button:disabled { opacity: 0.5; cursor: default; }
    button.primary { background: var(--accent); color: var(--bg); font-weight: 500; }
    .head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 0 8px; }
    .tabs { display: flex; gap: 4px; flex: 1; }
    .tab { background: transparent; border-radius: 8px 8px 0 0; padding: 6px 12px 8px; color: var(--muted); font-weight: 500; border-bottom: 2px solid transparent; }
    .tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--fg); }
    .watch { font-size: 12px; padding: 3px 10px; color: var(--muted); white-space: nowrap; }
    .watch[aria-pressed="true"] { color: var(--accent); }
    .icon { background: transparent; padding: 4px 8px; font-size: 16px; line-height: 1; }
    .body { border-top: 1px solid var(--line); }
    .collapsed .body { display: none; }
    .collapsed .head { padding-bottom: 8px; }
    .pane { display: none; }
    .pane.on { display: block; }
    .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid var(--line); }
    .bar select, .bar input[type=search], .ask input { background: var(--soft); border: 1px solid transparent; border-radius: 16px; padding: 5px 10px; min-width: 0; }
    .bar select { max-width: 150px; }
    .bar select option { color: #000; background: #fff; }
    .bar input[type=search] { flex: 1 1 90px; }
    input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .scroll { max-height: 440px; overflow-y: auto; overscroll-behavior: contain; }
    .row { display: flex; gap: 10px; padding: 5px 12px; cursor: pointer; }
    .row:hover { background: var(--soft); }
    .row.active { background: var(--soft); box-shadow: inset 3px 0 var(--accent); }
    .row[hidden] { display: none; }
    .t { color: var(--accent); font-variant-numeric: tabular-nums; flex: none; min-width: 40px; }
    .notimes .t { display: none; }
    .note { padding: 16px 12px; color: var(--muted); }
    .note button { margin-top: 10px; display: block; }
    .md { padding: 4px 12px 12px; overflow-wrap: anywhere; }
    .md p, .md ul, .md ol { margin: 8px 0; }
    .md ul, .md ol { padding-left: 20px; }
    .md li { margin: 3px 0; }
    .md .hd { font-weight: 700; font-size: 15px; margin: 14px 0 4px; }
    .md code { background: var(--soft); border-radius: 4px; padding: 0 4px; }
    .ts { background: transparent; color: var(--accent); padding: 0; border-radius: 2px; font-variant-numeric: tabular-nums; }
    .msg.user { margin: 10px 12px 2px 48px; padding: 8px 12px; background: var(--soft); border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .ask { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line); }
    .ask input { flex: 1; }
    .err { color: #d93025; padding: 4px 12px 12px; }
    .panel.dark .err { color: #ff8a80; }
  `;

  const host = h('div', { id: 'my-yt-transcript' });
  const root = host.attachShadow({ mode: 'open' });
  // Typing inside a shadow root looks to YouTube like typing on the page, so its
  // keyboard shortcuts (k, f, space, ...) would fire. Keep key events in here.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const ui = {};

  function build() {
    const style = h('style');
    style.textContent = CSS;

    ui.tabButtons = {};
    const tab = (id, label) =>
      (ui.tabButtons[id] = h('button', { class: 'tab', role: 'tab', onclick: () => selectTab(id) }, label));

    ui.collapse = h('button', { class: 'icon', title: 'Collapse', 'aria-label': 'Collapse panel', onclick: toggleCollapsed }, '▾');
    const head = h('div', { class: 'head' },
      h('div', { class: 'tabs', role: 'tablist' }, tab('transcript', 'Transcript'), tab('summary', 'Summary'), tab('chat', 'Chat')),
      (ui.watch = h('button', { class: 'watch', onclick: toggleWatch })),
      ext ? h('button', { class: 'icon', title: 'Settings', 'aria-label': 'Settings', onclick: openOptions }, '⚙') : null,
      ui.collapse,
    );

    // Transcript pane
    ui.lang = h('select', { 'aria-label': 'Caption language', onchange: onLangChange });
    ui.times = h('button', { onclick: toggleTimes }, 'Timestamps');
    ui.search = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search transcript', oninput: applySearch });
    ui.copy = h('button', { onclick: () => copyText(transcriptText(), ui.copy) }, 'Copy');
    ui.download = h('button', { onclick: download }, 'Download');
    ui.list = h('div', { class: 'scroll' });
    const transcriptPane = h('div', { class: 'pane' },
      h('div', { class: 'bar' }, ui.lang, ui.search, ui.times, ui.copy, ui.download),
      ui.list,
    );

    // Summary pane
    ui.summarize = h('button', { class: 'primary', onclick: summarize }, 'Summarize video');
    ui.summaryCopy = h('button', { onclick: () => copyText(state.summary, ui.summaryCopy) }, 'Copy');
    ui.summaryOut = h('div', { class: 'scroll' });
    const summaryPane = h('div', { class: 'pane' },
      h('div', { class: 'bar' }, ui.summarize, ui.summaryCopy),
      ui.summaryOut,
    );

    // Chat pane
    ui.chatOut = h('div', { class: 'scroll' });
    ui.chatInput = h('input', { type: 'text', placeholder: 'Ask about this video', 'aria-label': 'Ask about this video' });
    ui.chatSend = h('button', { class: 'primary', type: 'submit' }, 'Send');
    const form = h('form', { class: 'ask', onsubmit: onChatSubmit }, ui.chatInput, ui.chatSend);
    const chatPane = h('div', { class: 'pane' }, ui.chatOut, form);

    ui.panes = { transcript: transcriptPane, summary: summaryPane, chat: chatPane };
    ui.panel = h('div', { class: 'panel' }, head, h('div', { class: 'body' }, transcriptPane, summaryPane, chatPane));
    root.append(style, ui.panel);
    selectTab('transcript');
  }

  function selectTab(id) {
    state.tab = id;
    for (const [key, btn] of Object.entries(ui.tabButtons)) {
      btn.setAttribute('aria-selected', String(key === id));
      ui.panes[key].classList.toggle('on', key === id);
    }
    if (state.collapsed) toggleCollapsed();
  }

  function toggleCollapsed() {
    state.collapsed = !state.collapsed;
    ui.panel.classList.toggle('collapsed', state.collapsed);
    ui.collapse.textContent = state.collapsed ? '▸' : '▾';
    ui.collapse.title = state.collapsed ? 'Expand' : 'Collapse';
    setPref({ collapsed: state.collapsed });
  }

  function renderWatch() {
    ui.watch.textContent = state.watch ? 'Frames on' : 'Frames off';
    ui.watch.setAttribute('aria-pressed', String(state.watch));
    ui.watch.title = state.watch
      ? 'Summary and Chat also send still frames from the video, so Claude can see it. Click to send the transcript only.'
      : 'Summary and Chat send the transcript only. Click to also send still frames from the video.';
  }

  function toggleWatch() {
    state.watch = !state.watch;
    renderWatch();
    setPref({ watch: state.watch });
  }

  function toggleTimes() {
    state.showTimes = !state.showTimes;
    ui.list.classList.toggle('notimes', !state.showTimes);
    setPref({ showTimes: state.showTimes });
  }

  function openOptions() {
    try { ext.runtime.sendMessage({ type: 'openOptions' }); } catch { /* extension was reloaded */ }
  }

  function note(text, action) {
    return h('div', { class: 'note' }, text, action || null);
  }

  function setTranscriptControls(enabled) {
    for (const el of [ui.lang, ui.search, ui.times, ui.copy, ui.download]) el.disabled = !enabled;
  }

  function renderSegments() {
    state.activeIndex = -1;
    ui.rows = state.segments.map((seg) =>
      h('div', { class: 'row', onclick: () => seek(seg.start) },
        h('span', { class: 't' }, fmtTime(seg.start)),
        h('span', {}, seg.text)));
    ui.list.replaceChildren(...ui.rows);
    ui.list.scrollTop = 0;
    applySearch();
  }

  function applySearch() {
    const q = ui.search.value.trim().toLowerCase();
    (ui.rows || []).forEach((row, i) => {
      row.hidden = !!q && !state.segments[i].text.toLowerCase().includes(q);
    });
  }

  async function copyText(text, button) {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = label), 1200);
  }

  function download() {
    const m = state.meta || {};
    const header = `${m.title || 'YouTube video'}\n${m.author || ''}\nhttps://www.youtube.com/watch?v=${state.videoId}\n\n`;
    const name = (m.title || state.videoId).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) + '.txt';
    const url = URL.createObjectURL(new Blob([header + transcriptText() + '\n'], { type: 'text/plain' }));
    const a = h('a', { href: url, download: name });
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Minimal Markdown renderer (headings, lists, bold, code, clickable timestamps),
  // built from DOM nodes only so nothing from the model is ever parsed as HTML.
  function renderMarkdown(container, text) {
    const out = [];
    let list = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { list = null; continue; }
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        list = null;
        out.push(inline(h('div', { class: 'hd' }), m[1]));
      } else if ((m = line.match(/^[-*•]\s+(.*)$/))) {
        if (list?.tagName !== 'UL') out.push((list = h('ul')));
        list.append(inline(h('li'), m[1]));
      } else if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) {
        if (list?.tagName !== 'OL') out.push((list = h('ol')));
        list.append(inline(h('li', { value: m[1] }), m[2]));
      } else {
        list = null;
        out.push(inline(h('p'), line));
      }
    }
    container.replaceChildren(...out);
  }

  const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?)?\])/g;
  function inline(el, text) {
    for (const part of text.split(INLINE)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        el.append(h('strong', {}, part.slice(2, -2)));
      } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        el.append(h('code', {}, part.slice(1, -1)));
      } else if (/^\[\d{1,2}:\d{2}/.test(part)) {
        const sec = parseTime(part.match(/\d{1,2}:\d{2}(?::\d{2})?/)[0]);
        el.append(h('button', { class: 'ts', title: 'Jump to this moment', onclick: () => seek(sec) }, part));
      } else {
        el.append(part);
      }
    }
    return el;
  }

  // ---------- Claude (summary + chat) ----------

  // Streams a reply into `target`. Resolves with the full text (or null on error).
  function streamReply(messages, target, scroller) {
    return new Promise((resolve) => {
      const md = h('div', { class: 'md' });
      target.append(md);
      let text = '';
      let scheduled = false;
      const paint = () => {
        scheduled = false;
        const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        renderMarkdown(md, text);
        if (pinned) scroller.scrollTop = scroller.scrollHeight;
      };
      const fail = (message, needsKey) => {
        if (!text) md.remove();
        target.append(h('div', { class: 'err' }, message));
        if (needsKey) target.append(h('div', { class: 'note' }, h('button', { onclick: openOptions }, 'Open settings')));
        scroller.scrollTop = scroller.scrollHeight;
        finish(null);
      };
      let port;
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        state.cancelStream = null;
        try { port?.disconnect(); } catch { /* already closed */ }
        resolve(value);
      };

      if (!ext) return fail('The extension is not available on this page. Reload the tab.');
      try {
        port = ext.runtime.connect({ name: 'claude' });
      } catch {
        return fail('The extension was updated or reloaded. Reload this tab to keep using it.');
      }
      state.cancelStream = () => { paint(); finish(text || null); };
      port.onMessage.addListener((msg) => {
        if (msg.type === 'delta') {
          text += msg.text;
          if (!scheduled) { scheduled = true; requestAnimationFrame(paint); }
        } else if (msg.type === 'done') {
          if (msg.stopReason === 'refusal') text += (text ? '\n\n' : '') + '**Claude declined to answer this request.**';
          else if (msg.stopReason === 'max_tokens') text += '\n\n**The reply was cut off at the length limit.**';
          paint();
          finish(text);
        } else if (msg.type === 'notice') {
          md.before(h('div', { class: 'note' }, msg.text));
        } else if (msg.type === 'error') {
          fail(msg.message, msg.code === 'no_key');
        }
      });
      port.onDisconnect.addListener(() => { if (!finished) fail('The connection to the extension closed before the reply finished.'); });
      md.textContent = 'Thinking…';
      const visual = state.watch && state.storyboard
        ? { videoId: state.videoId, spec: state.storyboard, duration: state.duration }
        : null;
      port.postMessage({ context: aiContext(), messages, visual });
    });
  }

  // Claude needs something to go on: a transcript, or frames when Frames is on.
  function requireMaterial(target) {
    if (state.segments.length || (state.watch && state.storyboard)) return true;
    target.replaceChildren(note(state.storyboard
      ? 'This video has no transcript. Turn Frames on to let Claude work from the video frames instead.'
      : 'This video has no transcript or frames loaded, so there is nothing to send.'));
    return false;
  }

  async function summarize() {
    if (state.cancelStream) return state.cancelStream();
    if (!requireMaterial(ui.summaryOut)) return;
    const videoId = state.videoId;
    ui.summaryOut.replaceChildren();
    ui.summarize.textContent = 'Stop';
    ui.chatSend.disabled = true;
    const text = await streamReply([{ role: 'user', content: SUMMARY_PROMPT }], ui.summaryOut, ui.summaryOut);
    if (videoId !== state.videoId) return;
    state.summary = text || '';
    ui.summarize.textContent = text ? 'Regenerate' : 'Summarize video';
    ui.summaryCopy.disabled = !text;
    ui.chatSend.disabled = false;
  }

  async function onChatSubmit(e) {
    e.preventDefault();
    if (state.cancelStream) return state.cancelStream();
    const question = ui.chatInput.value.trim();
    if (!question) return;
    if (!state.chat.length) ui.chatOut.replaceChildren();
    if (!requireMaterial(ui.chatOut)) return;
    const videoId = state.videoId;
    ui.chatInput.value = '';
    ui.chatOut.append(h('div', { class: 'msg user' }, question));
    ui.chatOut.scrollTop = ui.chatOut.scrollHeight;
    // With Frames on, also show Claude what is on screen at this moment, in full
    // resolution, so questions like "what does this slide say?" work.
    const frame = state.watch ? captureFrame() : null;
    const content = frame
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.data } },
          { type: 'text', text: `The image above is the frame on screen right now, at [${fmtTime(frame.time)}].\n\n${question}` },
        ]
      : question;
    const messages = [...state.chat, { role: 'user', content }];
    ui.chatSend.textContent = 'Stop';
    ui.summarize.disabled = true;
    const answer = await streamReply(messages, ui.chatOut, ui.chatOut);
    if (videoId !== state.videoId) return;
    if (answer) state.chat = [...messages, { role: 'assistant', content: answer }];
    ui.chatSend.textContent = 'Send';
    ui.summarize.disabled = false;
  }

  // ---------- video lifecycle ----------

  function resetForVideo(videoId) {
    state.cancelStream?.();
    Object.assign(state, { videoId, meta: null, tracks: [], track: null, segments: [], summary: '', chat: [], activeIndex: -1, storyboard: null, duration: 0 });
    ui.rows = [];
    ui.search.value = '';
    ui.lang.replaceChildren();
    setTranscriptControls(false);
    ui.list.replaceChildren(note('Loading transcript…'));
    ui.summaryOut.replaceChildren(note('Get an overview, key points with timestamps, and takeaways. This sends the transcript, plus video frames when Frames is on, to the Claude API with your key.'));
    ui.summarize.textContent = 'Summarize video';
    ui.summarize.disabled = false;
    ui.summaryCopy.disabled = true;
    ui.chatOut.replaceChildren(note('Ask anything about this video, including what is on screen. Your questions, the transcript, and video frames when Frames is on, go to the Claude API with your key, and nowhere else.'));
    ui.chatSend.textContent = 'Send';
    ui.chatSend.disabled = false;
  }

  async function loadVideo(videoId) {
    resetForVideo(videoId);
    try {
      const [player, prefs] = await Promise.all([fetchPlayer(videoId), getPref(['lang'])]);
      if (videoId !== state.videoId) return;
      const d = player.videoDetails || {};
      state.meta = { title: d.title, author: d.author };
      state.duration = Number(d.lengthSeconds) || 0;
      state.storyboard = player.storyboards?.playerStoryboardSpecRenderer?.spec || null;
      state.tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!state.tracks.length) {
        const status = player.playabilityStatus;
        const why = status && status.status !== 'OK' && status.reason ? ` YouTube says: ${status.reason}` : '';
        const visual = state.storyboard ? ' Summary and Chat can still work from the video frames.' : '';
        ui.list.replaceChildren(note('This video has no captions, so there is no transcript to show.' + why + visual));
        return;
      }
      ui.lang.replaceChildren(...state.tracks.map((t, i) => h('option', { value: String(i) }, trackLabel(t))));
      await loadTrack(pickTrack(state.tracks, prefs.lang));
    } catch (err) {
      if (videoId !== state.videoId) return;
      ui.list.replaceChildren(note('Could not load the transcript. ' + (err?.message || err),
        h('button', { onclick: () => loadVideo(videoId) }, 'Try again')));
    }
  }

  async function loadTrack(track) {
    const videoId = state.videoId;
    state.track = track;
    ui.lang.value = String(state.tracks.indexOf(track));
    ui.lang.disabled = false;
    ui.list.replaceChildren(note('Loading transcript…'));
    const segments = await fetchSegments(track);
    if (videoId !== state.videoId || track !== state.track) return;
    state.segments = segments;
    // A different language means earlier answers no longer match the transcript.
    state.chat = [];
    setTranscriptControls(true);
    renderSegments();
  }

  function onLangChange() {
    const track = state.tracks[Number(ui.lang.value)];
    if (!track) return;
    setPref({ lang: track.languageCode });
    loadTrack(track).catch((err) => {
      ui.list.replaceChildren(note('Could not load that language. ' + (err?.message || err)));
    });
  }

  // Highlight the line being spoken. `timeupdate` does not bubble, so capture it.
  document.addEventListener('timeupdate', (e) => {
    if (!(e.target instanceof HTMLVideoElement) || !state.segments.length || state.collapsed || state.tab !== 'transcript') return;
    const t = e.target.currentTime;
    let lo = 0;
    let hi = state.segments.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state.segments[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === state.activeIndex) return;
    ui.rows[state.activeIndex]?.classList.remove('active');
    state.activeIndex = idx;
    const row = ui.rows[idx];
    if (!row) return;
    row.classList.add('active');
    if (!row.hidden && !ui.list.matches(':hover')) {
      ui.list.scrollTop = row.offsetTop - ui.list.offsetTop - ui.list.clientHeight / 3;
    }
  }, true);

  function tick() {
    const videoId = currentVideoId();
    if (!videoId) {
      if (state.videoId) { state.cancelStream?.(); state.videoId = null; }
      host.remove();
      return;
    }
    ui.panel.classList.toggle('dark', document.documentElement.hasAttribute('dark'));
    if (!host.isConnected) {
      const parent =
        document.querySelector('ytd-watch-flexy #secondary-inner') ||
        document.querySelector('ytd-watch-flexy #secondary');
      if (parent) parent.prepend(host);
    }
    if (host.isConnected && videoId !== state.videoId) loadVideo(videoId);
  }

  build();
  getPref(['collapsed', 'showTimes', 'watch']).then((prefs) => {
    if (prefs.watch === false) state.watch = false;
    renderWatch();
    if (prefs.showTimes === false) toggleTimes();
    if (prefs.collapsed) toggleCollapsed();
    document.addEventListener('yt-navigate-finish', tick);
    setInterval(tick, 1000);
    tick();
  });
})();
