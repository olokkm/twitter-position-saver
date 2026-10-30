#!/usr/bin/env node
// iPhone (390x844) Puppeteer simulation of the v3.42 jump against a fake
// ListLatestTweetsTimeline server. No real X, no login: every request to
// x.com is intercepted; anything not faked is aborted.
//
//   node scripts/sim-ios-jump.mjs [--targets 4d,1d,1h,crash] [--video out.mp4] [--seed 7]
//
// "crash": start a 4d restore, reload the tab mid-restore (what the iOS
// out-of-memory reload looks like), then expect "position too old" with no
// new jump — also after one more reload (no reload loop).
//
// Needs puppeteer-core (PUPPETEER_DIR, default /workspace/tps-sim) and Chrome
// (CHROME, default /usr/bin/google-chrome); ffmpeg for --video.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDataset, createFakeList, msFromSnowflake } from './fake-x-list.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire((process.env.PUPPETEER_DIR || '/workspace/tps-sim') + '/');
const puppeteer = require('puppeteer-core');

const TARGETS = opt('targets', '4d,1d,1h,crash').split(',');
const VIDEO = opt('video', null);
const SEED = Number(opt('seed', 7));
// X's real staleIntervalMs is 60 s; polls default off (list timelines).
const STALE_MS = Number(opt('stale', 60000)), POLL_MS = Number(opt('poll', 0));
const FAULT = opt('fault', '');
const XRULE = opt('xrule', 'on') !== 'off';
const SCROLL_BUDGET_MS = Number(opt('budget', 200000));
// --bar off: X merges Top responses in place (no new-posts bar). Default on:
// pinned list tabs park Top responses in the bar (see sim-fake-x-app.js).
const BAR = opt('bar', 'on') !== 'off';
// --tap-pill off: the reader never taps X's "N new posts" pill.
const TAP_PILL = opt('tap-pill', 'on') !== 'off';
const SKIP_POSTS = 40; // one swipe moves ~8-10 posts; more = the view skipped
const AGO = { '4d': 4 * 864e5, '3d': 3 * 864e5, '2d': 2 * 864e5, '1d': 864e5, '6h': 6 * 36e5, '1h': 36e5 };

const hookSrc = readFileSync(join(root, 'gear-extension/page-hook.js'), 'utf8');
const contentSrc = readFileSync(join(root, 'gear-extension/content.js'), 'utf8');
const appSrc = readFileSync(join(here, 'sim-fake-x-app.js'), 'utf8');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const frameDir = '/workspace/tps-sim/frames';
let frameN = 0;
if (VIDEO) { rmSync(frameDir, { recursive: true, force: true }); mkdirSync(frameDir, { recursive: true }); }

function monitorScript() {
  // Runs in every document before page scripts.
  window.__simMon = { maxMounted: 0, panel: [], pill: [] };
  setInterval(() => {
    const n = document.querySelectorAll('article[data-testid="tweet"]').length;
    if (n > window.__simMon.maxMounted) window.__simMon.maxMounted = n;
    const p = document.getElementById('timeline-saver-info') || document.querySelector('#timeline-saver-panel');
    const t = p ? p.textContent.trim() : '';
    const arr = window.__simMon.panel;
    if (t && arr[arr.length - 1] !== t) arr.push(t);
    // Fill pill ("Newer posts in N s" / "Loading newer posts…"): keep the
    // distinct texts (countdown digits folded) to see what it waited on.
    const w = document.getElementById('tps-fill-wait');
    const wt = w ? w.textContent.trim().replace(/\d+/g, '#') : '';
    const pa = window.__simMon.pill;
    if (wt && pa[pa.length - 1] !== wt) { pa.push(wt); if (pa.length > 40) pa.shift(); }
  }, 50);
}

async function runTarget(browser, label) {
  const crash = label === 'crash';
  const now = Date.now();
  const ds = makeDataset({ nowMs: now, days: 4.5, posts: 1500, seed: SEED });
  const fake = createFakeList(ds);
  const want = now - AGO[crash ? '4d' : label];
  let target = ds[0];
  for (const p of ds) { if (p.ms <= want) { target = p; break; } }

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.emulate({
    userAgent: UA,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  });
  const cdp = await page.createCDPSession();
  if (VIDEO) {
    cdp.on('Page.screencastFrame', async (f) => {
      writeFileSync(join(frameDir, String(frameN++).padStart(6, '0') + '.jpg'), Buffer.from(f.data, 'base64'));
      try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (_) { /* closed */ }
    });
  }
  await page.setRequestInterception(true);
  const appHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Home / X (sim)</title></head><body>' +
    '<script>window.__SIM=' + JSON.stringify({ staleMs: STALE_MS, pollMs: POLL_MS, fault: FAULT, xrule: XRULE, bar: BAR }) + ';</script><script>' + appSrc + '</script></body></html>';
  page.on('request', async (req) => {
    const u = req.url();
    try {
      if (/^https:\/\/x\.com\/i\/api\/graphql\/[^/]+\/ListLatestTweetsTimeline/.test(u)) {
        const body = JSON.stringify(fake.respond(u));
        await sleep(120 + Math.floor(Math.random() * 200)); // network latency
        return req.respond({ status: 200, contentType: 'application/json', body });
      }
      if (u === 'https://x.com/home' || u === 'https://x.com/home/') {
        return req.respond({ status: 200, contentType: 'text/html', body: appHtml });
      }
      if (u === 'https://x.com/i/sim-blank') {
        return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
      }
      return req.abort();
    } catch (_) { /* already handled */ }
  });

  // Seed the saved position (as if saved by the userscript on Oct 25 etc.).
  await page.goto('https://x.com/i/sim-blank');
  await page.evaluate((t) => {
    const set = (k, v) => localStorage.setItem('tps_' + k, JSON.stringify(v));
    set('tweet_id', t.id); set('tweet_time', new Date(t.ms).toISOString());
    set('sort_pos', t.id); set('timestamp', Date.now()); set('path', '/home');
  }, { id: target.id, ms: target.ms });

  await page.evaluateOnNewDocument(monitorScript);
  await page.evaluateOnNewDocument(hookSrc);     // MAIN world, document_start
  await page.evaluateOnNewDocument(contentSrc);  // content script, document_start
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
  if (process.env.SIM_LOG) page.on('console', (m) => { const t = m.text(); if (/TPS|fill|kick|reload|Timeline/i.test(t)) console.error(((Date.now() - t0) / 1000).toFixed(1) + 's', t.slice(0, 200)); });

  if (VIDEO) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 390, maxHeight: 844, everyNthFrame: 1 });
  const t0 = Date.now();
  await page.goto('https://x.com/home');
  const navsAfterLoad = navs;

  if (crash) {
    const panelState = () => page.evaluate(() => {
      const p = document.getElementById('timeline-saver-panel');
      return { btn: !!(p && p.querySelector('button')), text: p ? p.textContent.trim() : '' };
    });
    const waitFinal = async () => {
      for (let i = 0; i < 200; i++) {
        await sleep(100);
        const st = await panelState();
        if (st.text && !st.btn && /too old|Jumped|not found|Stopped|missed|Reached/.test(st.text)) return st.text;
      }
      return '';
    };
    // Reload while the restore is still running (Stop button visible).
    let midRestore = false;
    for (let i = 0; i < 100 && !midRestore; i++) { await sleep(50); midRestore = (await panelState()).btn; }
    const fetchesBefore = fake.log.length;
    await page.reload();
    const text1 = await waitFinal();
    const fetches1 = fake.log.length - fetchesBefore;
    const oldTime = (text1.match(/too old \(([^)]+)\)/) || [])[1] || '';
    const deepFetches1 = fake.log.slice(fetchesBefore).filter((e) => e.kind === 'bottom').length;
    await sleep(1500);
    const f2 = fake.log.length;
    // After the skip the user sits at the top, so leaving the page saves that
    // (recent) position; the old deep one must not be jumped to again.
    await page.reload();
    const text2 = await waitFinal();
    await sleep(3000);
    const deepFetches2 = fake.log.slice(f2).filter((e) => e.kind === 'bottom').length;
    const st = await page.evaluate(() => ({ y: Math.round(scrollY), n: document.querySelectorAll('article[data-testid="tweet"]').length }));
    if (VIDEO) { try { await cdp.send('Page.stopScreencast'); } catch (_) { /* */ } }
    await ctx.close();
    const res = {
      label, targetIdx: ds.indexOf(target), midRestore, afterCrash: text1, afterSecondReload: text2,
      fetchesAfterCrash: fetches1, deepFetchesAfterCrash: deepFetches1, deepFetchesAfterSecondReload: deepFetches2,
      scrollYAtEnd: st.y, mountedAtEnd: st.n, pageErrors: consoleErrors.slice(0, 5)
    };
    res.pass = midRestore && /too old/.test(text1) && /crash:skip/.test(text1) && 
      (/too old/.test(text2) || (!!oldTime && !text2.includes(oldTime) && !/window around/.test(text2))) &&
      deepFetches1 === 0 && deepFetches2 <= 2 && st.n > 0 && !res.pageErrors.length;
    return res;
  }

  // Wait for the restore to finish (panel loses its Stop button).
  let finalText = '';
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    const st = await page.evaluate(() => {
      const p = document.getElementById('timeline-saver-panel');
      return { has: !!p, btn: !!(p && p.querySelector('button')), text: p ? p.textContent.trim() : '',
        result: document.documentElement.getAttribute('data-tps-jump-result') || '' };
    });
    if (st.has && !st.btn && /Jumped|not found|too old|Stopped|missed|Reached/.test(st.text)) { finalText = st.text; break; }
  }
  const landMs = Date.now() - t0;
  const land = await page.evaluate((id) => {
    const a = [...document.querySelectorAll('article[data-testid="tweet"]')].find((x) => x.querySelector('a[href*="/status/' + id + '"]'));
    const r = a ? a.getBoundingClientRect() : null;
    const de = document.documentElement;
    return { found: !!a, top: r ? Math.round(r.top) : null, vh: innerHeight, scrollY: Math.round(scrollY),
      mode: de.getAttribute('data-tps-jump-mode'), fill: de.getAttribute('data-tps-fill'),
      result: de.getAttribute('data-tps-jump-result'), loaded: window.__simApp.ids().length };
  }, target.id);
  const landed = land.found && land.top >= 0 && land.top <= land.vh * 0.6;
  const fetchesToLand = fake.log.length;

  const ds_index = new Map(ds.map((p, i) => [p.id, i]));
  // Top visible post (first article below the sticky tab bar), as an index
  // into the dataset (0 = newest).
  const topVisible = async () => {
    const id = await page.evaluate(() => {
      let best = null, bestTop = Infinity;
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        const r = a.getBoundingClientRect();
        if (r.bottom > 60 && r.top < innerHeight && r.top < bestTop) {
          const l = a.querySelector('a[href*="/status/"]');
          const m = l && l.getAttribute('href').match(/status\/(\d+)/);
          if (m) { best = m[1]; bestTop = r.top; }
        }
      }
      return best;
    });
    return id == null ? null : ds_index.get(id);
  };
  const landTopIdx = await topVisible();
  // Idle away from the top: background polls must be held (no backend Top).
  const logBeforeIdle = fake.log.length;
  await sleep(Math.max(POLL_MS * 2, 3000) + 500);
  const idleTop = fake.log.slice(logBeforeIdle).filter((e) => e.kind === 'top' || e.kind === 'head').length;
  const idleFill = await page.evaluate(() => document.documentElement.getAttribute('data-tps-fill'));
  // Still at the saved post after idling (nothing moved the view).
  const idleTopIdx = await topVisible();
  const savedInView = await page.evaluate((id) => {
    const a = [...document.querySelectorAll('article[data-testid="tweet"]')].find((x) => x.querySelector('a[href*="/status/' + id + '"]'));
    const r = a && a.getBoundingClientRect();
    return !!r && r.bottom > 60 && r.top < innerHeight;
  }, target.id);

  // User scrolls up until the newest post is loaded and visible.
  const contiguity = [];
  const checkGaps = async () => {
    const ids = await page.evaluate(() => window.__simApp.ids());
    const idx = ids.map((id) => ds_index.get(id));
    let gaps = 0;
    for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) gaps++;
    return { gaps, n: ids.length, newest: idx[0], oldest: idx[idx.length - 1] };
  };
  // A skip = the top visible post became more than SKIP_POSTS newer in one
  // step and stayed there (re-checked after 3 s, so a re-anchor that jumps
  // back counts as fine).
  const skips = [];
  let lastTopIdx = await topVisible();
  const checkSkip = async (why) => {
    let t = await topVisible();
    if (t != null && lastTopIdx != null && lastTopIdx - t > SKIP_POSTS) {
      await sleep(3000);
      t = await topVisible();
      if (t != null && lastTopIdx - t > SKIP_POSTS) {
        const loaded = await page.evaluate(() => window.__simApp.ids());
        const idx = loaded.map((id) => ds_index.get(id));
        const between = idx.filter((i) => i > t && i < lastTopIdx).length;
        skips.push({ why, from: lastTopIdx, to: t, skipped: lastTopIdx - t - 1,
          // 'position lost' = the skipped posts are in X's list (scroll up
          // reaches them); 'never present' = they are not loaded at all.
          kind: between >= lastTopIdx - t - 1 ? 'loaded-but-position-lost' : 'gap-posts-never-present' });
      }
    }
    if (t != null) lastTopIdx = t;
  };
  let pillTaps = 0;
  let reachedNow = false, gestures = 0, gapEver = 0;
  const tScroll = Date.now();
  let atTopWaits = 0;
  while (Date.now() - tScroll < SCROLL_BUDGET_MS) {
    // A touch tap first (counts as a gesture like a finger on the screen),
    // then a wheel-type scroll gesture: headless Chrome ignores synthesized
    // touch scrolls, so the swipe itself is a 'mouse' gesture.
    if (gestures === 0) await page.touchscreen.tap(195, 600);
    // A reader at the very top of the list stops swiping and waits for
    // newer posts (as on the phone) instead of swiping forever.
    const yNow = await page.evaluate(() => scrollY);
    if (gestures > 0 && yNow < 5) {
      atTopWaits++; await sleep(1000);
      // A reader waiting at the top taps X's "N new posts" pill after a while.
      if (TAP_PILL && atTopWaits % 4 === 0 && await page.evaluate(() => !!document.getElementById('sim-new-pill') && document.getElementById('sim-new-pill').isConnected)) {
        pillTaps++;
        await page.evaluate(() => document.getElementById('sim-new-pill').click());
        await sleep(400);
      }
      await checkSkip('wait');
    } else {
      await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 400, yDistance: 1600, speed: 3000, gestureSourceType: 'mouse' });
      gestures++;
      await sleep(250);
      await checkSkip('swipe');
    }
    const g = await checkGaps();
    contiguity.push(g);
    if (g.gaps) gapEver++;
    const y = await page.evaluate(() => scrollY);
    if (g.newest === 0 && y < 5) { reachedNow = true; break; }
  }
  const tReached = Date.now();
  await sleep(1500);
  const end = await checkGaps();
  const barLeft = await page.evaluate(() => window.__simApp.barIds().length);
  const endState = await page.evaluate(() => ({
    fill: document.documentElement.getAttribute('data-tps-fill'),
    maxMounted: window.__simMon.maxMounted, appMax: window.__simApp.stats.maxMounted, stats: window.__simApp.stats,
    panel: window.__simMon.panel.slice(-6), pill: window.__simMon.pill.slice(-12)
  }));
  // Debug log: if the fill pill is still up, tap it and read the panel.
  const debugLog = await page.evaluate(async () => {
    const pill = document.getElementById('tps-fill-wait');
    if (!pill || pill.style.display === 'none' || !pill.textContent) return null;
    pill.click();
    await new Promise((r) => setTimeout(r, 300));
    const box = document.getElementById('tps-fill-log');
    return box ? box.innerText.split('\n').slice(0, 14) : 'no panel';
  });
  // After "now": X's next poll must pass straight through (no rewrite).
  const lastTop = fake.log.filter((e) => e.kind === 'top').slice(-1)[0];
  if (VIDEO) { try { await cdp.send('Page.stopScreencast'); } catch (_) { /* */ } }
  const reloads = navs - navsAfterLoad;
  await ctx.close();

  const res = {
    label, targetIdx: ds_index.get(target.id), targetAgeH: +((now - target.ms) / 36e5).toFixed(1),
    landed, landTopPx: land.top, landMs, finalText, mode: land.mode, result: land.result,
    fetchesToLand, loadedAtLand: land.loaded, idleBackendTop: idleTop, idleFill,
    gestures, reachedNow, gapEver, endGaps: end.gaps, endLoaded: end.n, endNewest: end.newest, endOldest: end.oldest,
    fillEnd: endState.fill, maxMounted: Math.max(endState.maxMounted, endState.appMax), reloads,
    backend: { total: fake.log.length, top: fake.log.filter((e) => e.kind === 'top').length,
      bottom: fake.log.filter((e) => e.kind === 'bottom').length, head: fake.log.filter((e) => e.kind === 'head').length },
    landTopIdx, idleTopIdx, stayedAtSaved: idleTopIdx === landTopIdx && savedInView, skips, pillTaps, barLeft,
    lastTopB: lastTop ? lastTop.B : null, app: endState.stats, atTopWaitSec: atTopWaits, scrollSec: Math.round((tReached - tScroll) / 1000),
    fault: FAULT || undefined, pill: endState.pill, panel: endState.panel, debugLog: debugLog || undefined,
    pageErrors: consoleErrors.slice(0, 5)
  };
  res.pass = res.landed && res.reachedNow && !res.gapEver && !res.endGaps && res.maxMounted <= 100 &&
    res.stayedAtSaved && !res.skips.length && !res.barLeft &&
    res.reloads === 0 && (res.mode !== 'window' || res.idleBackendTop === 0) && !res.pageErrors.length;
  return res;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const results = [];
try {
  for (const t of TARGETS) {
    const r = await runTarget(browser, t);
    results.push(r);
    console.log(JSON.stringify(r));
  }
} finally { await browser.close(); }
if (VIDEO && frameN) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '15', '-i', join(frameDir, '%06d.jpg'),
    '-vf', 'scale=390:844:force_original_aspect_ratio=decrease,pad=390:844:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', VIDEO]);
  console.log('video', VIDEO, frameN, 'frames');
}
const ok = results.every((r) => r.pass);
console.log(ok ? 'SIM PASS' : 'SIM FAIL', results.map((r) => r.label + ':' + (r.pass ? 'ok' : 'FAIL')).join(' '));
process.exit(ok ? 0 : 1);
