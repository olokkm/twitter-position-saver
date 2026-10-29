// Minimal fake x.com/home for scripts/sim-ios-jump.mjs (no real X, no login).
// Mobile layout, For you / Following / Olo tabs (Olo selected), a virtualized
// list timeline driven by ListLatestTweetsTimeline with X-like cursor use:
// initial + Bottom requests count 20, Top requests count 40, manual scroll
// anchoring on prepend (overflow-anchor is off).
// Top fetches follow X's client (SCROLLER / AbsolutePower edge proximity):
//  - near_top: onNearStart fires only when the viewport top ENTERS the zone
//    (list top + 0.25 * viewport height) or the list length changes while
//    inside; it is skipped when the last top/initial fetch is younger than
//    staleIntervalMs (X: 60 s, lastTopFetchTimestamp).
//  - foreground poll (only if SIM.pollMs > 0): fetchInitialOrTop({polling}),
//    header x-twitter-polling: true, not stale-gated.
//  - refreshOrGoTop (tap on the Home nav link while on /home): at newest
//    (viewport top within 50 px of the list top) → refresh = Top fetch with
//    no stale gate; otherwise scroll to top.
(function () {
  'use strict';
  const SIM = window.__SIM || {};
  const STALE_MS = SIM.staleMs != null ? SIM.staleMs : 60000;
  const POLL_MS = SIM.pollMs || 0;
  const NEAR_START_RATIO = 0.25;
  const OVERSCAN = 1.5;
  let cells = []; // newest first: {id, iso, text, h}
  const byId = new Map();
  let topCursor = null, bottomCursor = null;
  let lastTopAt = 0, busyTop = false, busyBottom = false;
  let offsets = [];
  let tabSel = 'Olo';
  let tl, mounted = new Map();
  let nearStartInside = null, nearStartLen = -1;
  const stats = window.__simStats = { staleSkips: 0, refreshes: 0, topReq: 0, bottomReq: 0, headReq: 0, prepended: 0, appended: 0, maxMounted: 0 };

  function hashH(id) { let h = 0; for (const c of id.slice(-6)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 150 + (h % 5) * 30; }
  function url(cursor, count) {
    const v = { listId: '1234567890', count, includePromotedContent: false };
    if (cursor) v.cursor = cursor;
    return '/i/api/graphql/FAKEqid/ListLatestTweetsTimeline?variables=' + encodeURIComponent(JSON.stringify(v)) + '&features=%7B%7D';
  }
  function parse(json) {
    const ents = json.data.list.tweets_timeline.timeline.instructions[0].entries;
    const tweets = [];
    let top = null, bottom = null;
    for (const e of ents) {
      if (e.entryId.startsWith('cursor-top-') || (e.content && e.content.cursorType === 'Top')) top = e.content.value;
      else if (e.entryId.startsWith('cursor-bottom-') || (e.content && e.content.cursorType === 'Bottom')) bottom = e.content.value;
      else if (e.entryId.startsWith('tweet-')) {
        const r = e.content.itemContent.tweet_results.result;
        tweets.push({ id: r.rest_id, iso: new Date(r.legacy.created_at).toISOString(), text: r.legacy.full_text, h: hashH(r.rest_id) });
      }
    }
    return { tweets, top, bottom };
  }
  async function get(u, extra) {
    const headers = Object.assign({ authorization: 'Bearer sim', 'x-csrf-token': 'sim', 'x-client-transaction-id': 'sim' }, extra || {});
    const res = await fetch(u, { headers, credentials: 'include' });
    return parse(await res.json());
  }
  function relayout() {
    offsets = new Array(cells.length);
    let y = 0;
    for (let i = 0; i < cells.length; i++) { offsets[i] = y; y += cells[i].h; }
    tl.style.height = y + 'px';
  }
  function render() {
    if (!tl) return;
    const base = tl.getBoundingClientRect().top + window.scrollY;
    const vh = window.innerHeight;
    const y0 = window.scrollY - base - OVERSCAN * vh, y1 = window.scrollY - base + (1 + OVERSCAN) * vh;
    const want = new Set();
    for (let i = 0; i < cells.length; i++) {
      const top = offsets[i], bot = top + cells[i].h;
      if (bot < y0 || top > y1) continue;
      want.add(cells[i].id);
      let el = mounted.get(cells[i].id);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-testid', 'cellInnerDiv');
        const c = cells[i];
        el.innerHTML = '<article data-testid="tweet" role="article"><div class="hd"><b>Olo member</b> · ' +
          '<a href="/olo/status/' + c.id + '"><time datetime="' + c.iso + '">' + c.iso.slice(5, 16).replace('T', ' ') +
          '</time></a></div><div class="tx">' + c.text + '</div></article>';
        tl.appendChild(el);
        mounted.set(c.id, el);
      }
      el.style.top = offsets[i] + 'px';
      el.style.height = cells[i].h + 'px';
    }
    for (const [id, el] of mounted) if (!want.has(id)) { el.remove(); mounted.delete(id); }
    const n = document.querySelectorAll('article[data-testid="tweet"]').length;
    if (n > stats.maxMounted) stats.maxMounted = n;
  }
  function add(tweets, where) {
    const fresh = tweets.filter((t) => !byId.has(t.id));
    for (const t of fresh) byId.set(t.id, t);
    if (!fresh.length) return 0;
    if (where === 'top') {
      const addH = fresh.reduce((a, t) => a + t.h, 0);
      const y = window.scrollY;
      cells = fresh.concat(cells);
      relayout();
      // X keeps the reading position when it inserts above (manual anchoring).
      if (y > 0) window.scrollTo(0, y + addH);
      stats.prepended += fresh.length;
      render();
      checkNearStart();
      return fresh.length;
    } else {
      cells = cells.concat(fresh);
      relayout();
      stats.appended += fresh.length;
    }
    render();
    checkNearStart();
    return fresh.length;
  }
  async function loadHead() {
    stats.headReq++;
    const r = await get(url(null, 20));
    cells = []; byId.clear();
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    add(r.tweets, 'bottom');
    topCursor = r.top; bottomCursor = r.bottom; lastTopAt = Date.now();
  }
  async function loadTop(reason) {
    if (busyTop || !topCursor || tabSel !== 'Olo') return;
    // near_top is onlyIfStale; polls and refresh are not.
    if (reason === 'near-top' && Date.now() - lastTopAt < STALE_MS) { stats.staleSkips++; return; }
    busyTop = true; stats.topReq++;
    try {
      const r = await get(url(topCursor, 40), reason === 'poll' ? { 'x-twitter-polling': 'true' } : null);
      add(r.tweets, 'top');
      if (r.top) topCursor = r.top;
      lastTopAt = Date.now();
    } finally { busyTop = false; }
  }
  async function loadBottom() {
    if (busyBottom || !bottomCursor || tabSel !== 'Olo') return;
    busyBottom = true; stats.bottomReq++;
    try {
      const r = await get(url(bottomCursor, 20));
      add(r.tweets, 'bottom');
      if (r.bottom) bottomCursor = r.bottom;
    } finally { busyBottom = false; }
  }
  function onScroll() {
    render();
    const vh = window.innerHeight;
    const max = document.documentElement.scrollHeight - vh;
    if (window.scrollY > max - 2.5 * vh) loadBottom();
    checkNearStart();
  }
  function listTopDoc() { return tl.getBoundingClientRect().top + window.scrollY; }
  // X edge proximity: fire on OUTSIDE→INSIDE movement, or on a list length
  // change while inside (LIST_UPDATE). Never repeatedly while just sitting.
  function checkNearStart() {
    if (!tl || !cells.length) return;
    const inside = window.scrollY - listTopDoc() <= NEAR_START_RATIO * window.innerHeight;
    const fire = inside && (nearStartInside === false || nearStartInside === null || nearStartLen !== cells.length);
    nearStartInside = inside; nearStartLen = cells.length;
    if (fire) loadTop('near-top');
  }
  function isAtNewest() { return window.scrollY - listTopDoc() <= 50; }
  function refreshOrGoTop() {
    if (!isAtNewest()) { window.scrollTo(0, 0); return; }
    stats.refreshes++;
    loadTop('refresh');
  }
  function selectTab(name) {
    tabSel = name;
    document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.textContent.trim() === name)));
    cells = []; byId.clear(); topCursor = bottomCursor = null;
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    relayout();
    window.scrollTo(0, 0);
    if (name === 'Olo') setTimeout(loadHead, 120);
  }
  function boot() {
    document.body.innerHTML =
      // Mobile layout (AGENTS.md): the tab bar sits outside primaryColumn.
      '<div id="react-root"><main role="main"><div class="tabs" role="tablist">' +
      ['For you', 'Following', 'Olo'].map((n) => '<div role="tab" aria-selected="' + (n === 'Olo') + '"><span>' + n + '</span></div>').join('') +
      '</div><div data-testid="primaryColumn"><section aria-label="Timeline"><div id="tl"></div></section></div></main></div>';
    const st = document.createElement('style');
    st.textContent = 'body{margin:0;font:15px -apple-system,Helvetica,sans-serif;background:#000;color:#e7e9ea}' +
      '.tabs{position:sticky;top:0;z-index:5;display:flex;background:rgba(0,0,0,.85);border-bottom:1px solid #2f3336}' +
      '[role=tab]{flex:1;text-align:center;padding:16px 0;color:#71767b}[role=tab][aria-selected=true]{color:#fff;font-weight:700;box-shadow:inset 0 -4px #1d9bf0}' +
      '#tl{position:relative}[data-testid=cellInnerDiv]{position:absolute;left:0;right:0;box-sizing:border-box;border-bottom:1px solid #2f3336;padding:12px 16px;overflow:hidden}' +
      '.hd{color:#71767b;margin-bottom:6px}.hd b{color:#e7e9ea}a{color:#71767b;text-decoration:none}.tx{line-height:1.35}';
    document.head.appendChild(st);
    tl = document.getElementById('tl');
    document.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.textContent.trim())));
    // SPA: link taps never navigate the document (the sim's touch tap can
    // land on a status link).
    document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); }, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    if (POLL_MS > 0) setInterval(() => loadTop('poll'), POLL_MS);
    // Bottom nav Home link (mobile): tapping it on /home = onTabRefresh.
    const nav = document.createElement('nav');
    nav.setAttribute('role', 'navigation');
    nav.innerHTML = '<a href="/home" data-testid="AppTabBar_Home_Link" aria-label="Home" role="link">Home</a>';
    nav.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:50px;background:#000;border-top:1px solid #2f3336;z-index:6;text-align:center;line-height:50px';
    document.body.appendChild(nav);
    nav.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); refreshOrGoTop(); });
    setTimeout(loadHead, SIM.headDelayMs || 400);
    window.__simApp = { ids: () => cells.map((c) => c.id), topCursor: () => topCursor, stats, lastTopAt: () => lastTopAt };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
