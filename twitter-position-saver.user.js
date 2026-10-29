// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.44
// @description  Remembers where you stopped scrolling on the X "Olo" timeline and jumps back there on your next visit.
// @author       zaengerlein
// @license      MIT
// @match        https://twitter.com/*
// @match        https://x.com/*
// @updateURL    https://raw.githubusercontent.com/olokkm/twitter-position-saver/main/twitter-position-saver.user.js
// @downloadURL  https://raw.githubusercontent.com/olokkm/twitter-position-saver/main/twitter-position-saver.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

const TPS_VERSION = '3.44';

/* TPS_SCROLL_GUARD_BEGIN */
// Page-realm scroll block. Runs via unsafeWindow (Tampermonkey) or MAIN-world
// page-hook.js (Gear/Chrome extension). Blocks X's jump-to-top while mid-feed
// unless a recent user gesture or data-tps-allow-scroll window is active.
// Optional on-screen overlay: localStorage tps_debug_scroll=1 or #tpsdebug.
// v3.38: scrollBy deltas → absolute nextY (fixes iOS idle-normalize blocks).
// v3.39: noanchor overlay uses getComputedStyle (not CSS.supports); wrap more
//        scroll writers (debug-only).
// v3.40: drop unverified AbsolutePower _heights seeding (isolated-world miss).
function tpsInstallPageScrollGuard(globalObj) {
    'use strict';
    const g = globalObj || (typeof window !== 'undefined' ? window : null);
    if (!g || g.__tpsScrollGuardInstalled) return;
    g.__tpsScrollGuardInstalled = true;

    // Guard ONLY blocks X jump-to-top; it never writes scrollTop/scrollTo itself.
    // Momentum: after a real gesture, keep allowing while scroll events keep arriving
    // so we do not block X's layout compensation when iOS fling decelerates.
    const USER_GRACE_MS = 900;
    const MOMENTUM_ARM_MS = 2500;
    const MOMENTUM_EXTEND_MS = 180;
    const MID_FEED_Y = 280;
    const TOP_TARGET_Y = 140;
    const BIG_JUMP_PX = 350;

    let lastGestureAt = 0;
    let momentumUntil = 0;
    g.__tpsAllowScrollUntil = 0;

    function readDebugEnabled() {
        try {
            const h = String(g.location && g.location.hash || '');
            if (/(?:^|[&#])tpsdebugoff(?:&|$)/.test(h)) return false;
            if (/(?:^|[&#])tpsdebug(?:&|$)/.test(h)) return true;
        } catch (_) { /* ignore */ }
        try {
            return g.localStorage && g.localStorage.getItem('tps_debug_scroll') === '1';
        } catch (_) {
            return false;
        }
    }

    const DEBUG = readDebugEnabled();

    // ---- optional overlay (zero cost when DEBUG is false) ----
    const RING_MAX = 8;
    const dbgRing = DEBUG ? [] : null;
    let dbgEl = null;
    let dbgRaf = 0;
    let dbgTouching = false;
    let dbgLastScrollY = 0;
    let dbgLastFrameDy = 0;
    let dbgMomentumMarked = false;
    let dbgTouchLastY = 0;
    let dbgAnchorSupports = '';

    function dbgNow() {
        return Date.now();
    }

    function dbgPush(line) {
        if (!DEBUG || !dbgRing) return;
        const t = dbgNow();
        dbgRing.push({ t: t, line: line });
        while (dbgRing.length > RING_MAX) dbgRing.shift();
        if (!dbgRaf) {
            dbgRaf = g.requestAnimationFrame(function () {
                dbgRaf = 0;
                dbgRender();
            });
        }
    }


    function readNoAnchorFlag() {
        try {
            if (g.localStorage && g.localStorage.getItem('tps_debug_noanchor') === '1') return true;
        } catch (_) { /* ignore */ }
        try {
            const h = String(g.location && g.location.hash || '');
            if (/(?:^|[&#])tpsnoanchor(?:&|$)/.test(h)) return true;
        } catch (_) { /* ignore */ }
        return false;
    }

    function overflowAnchorOf(el) {
        if (!el) return '?';
        try {
            const cs = g.getComputedStyle(el);
            return cs.getPropertyValue('overflow-anchor').trim() || cs.overflowAnchor || '?';
        } catch (_) {
            return '?';
        }
    }

    // Report whether NOANCHOR is active on the real scrollers (not CSS.supports).
    function readOverflowAnchorReport() {
        try {
            const doc = g.document;
            if (!doc) return '?';
            const se = doc.scrollingElement || doc.documentElement;
            const html = doc.documentElement;
            const body = doc.body;
            const flag = readNoAnchorFlag();
            const aSe = overflowAnchorOf(se);
            const aHtml = overflowAnchorOf(html);
            const aBody = overflowAnchorOf(body);
            // Effective: all none => disabled (iOS-like); else show values.
            const off = (aSe === 'none' && aHtml === 'none' && (!body || aBody === 'none'));
            return (flag ? 'flag' : 'noflag') + ':' + (off ? 'OFF' : 'ON') +
                '(se=' + aSe + ' html=' + aHtml + ' body=' + aBody + ')';
        } catch (_) {
            return '?';
        }
    }

    function ensureNoAnchorCss() {
        if (!readNoAnchorFlag()) return false;
        try {
            const doc = g.document;
            if (!doc) return false;
            if (doc.getElementById('tps-debug-noanchor')) return true;
            const s = doc.createElement('style');
            s.id = 'tps-debug-noanchor';
            // Cover window scroller + common X timeline roots.
            s.textContent = [
                'html, body, html body, #react-root, #react-root > div,',
                '[data-testid="primaryColumn"], [data-testid="primaryColumn"] *,',
                '[data-testid="cellInnerDiv"], [data-testid="cellInnerDiv"] *',
                '{ overflow-anchor: none !important; }'
            ].join(' ');
            (doc.documentElement || doc.head || doc.body).appendChild(s);
            dbgPush('noanchor css injected');
            return true;
        } catch (_) {
            return false;
        }
    }

    function dbgEnsureOverlay() {
        if (!DEBUG || dbgEl) return dbgEl;
        try {
            const doc = g.document;
            if (!doc || !doc.documentElement) return null;
            try {
                dbgAnchorSupports = readOverflowAnchorReport();
            } catch (_) {
                dbgAnchorSupports = '?';
            }
            const el = doc.createElement('div');
            el.id = 'tps-scroll-debug';
            el.setAttribute('data-tps-inject', 'debug');
            el.style.cssText = [
                'position:fixed',
                'left:6px',
                'bottom:72px',
                'z-index:2147483646',
                'pointer-events:none',
                'max-width:min(96vw,420px)',
                'max-height:42vh',
                'overflow:hidden',
                'padding:6px 8px',
                'border-radius:8px',
                'background:rgba(0,0,0,0.72)',
                'color:#b8f5c5',
                'font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
                'white-space:pre-wrap',
                'word-break:break-word',
                'box-shadow:0 2px 10px rgba(0,0,0,0.45)'
            ].join(';');
            (doc.documentElement || doc.body).appendChild(el);
            dbgEl = el;
            ensureNoAnchorCss();
            try { dbgAnchorSupports = readOverflowAnchorReport(); } catch (_) { /* ignore */ }
            dbgPush('overlay on oa=' + dbgAnchorSupports);
            return el;
        } catch (_) {
            return null;
        }
    }

    function dbgRender() {
        if (!DEBUG) return;
        const el = dbgEnsureOverlay();
        if (!el || !dbgRing) return;
        const now = dbgNow();
        const y = Math.round(currentY());
        let oa = dbgAnchorSupports;
        try { oa = readOverflowAnchorReport(); dbgAnchorSupports = oa; } catch (_) { /* ignore */ }
        const lines = [
            'TPS dbg y=' + y + ' oa=' + oa +
            (dbgLastBlk ? ' | LAST ' + dbgLastBlk : '')
        ];
        for (let i = 0; i < dbgRing.length; i++) {
            const age = now - dbgRing[i].t;
            lines.push('-' + age + 'ms ' + dbgRing[i].line);
        }
        el.textContent = lines.join('\n');
    }

    function isOurWrite() {
        try {
            const el = g.document && g.document.documentElement;
            if (!el) return null;
            const until = Number(el.getAttribute('data-tps-our-scroll-until') || 0);
            if (Date.now() <= until) {
                return el.getAttribute('data-tps-our-scroll') || 'tps';
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    let dbgLastBlk = '';

    function dbgLogWrite(kind, fromY, toY, blocked, ours) {
        if (!DEBUG) return;
        const who = ours ? ('us:' + ours) : 'X';
        const d = (typeof toY === 'number' && typeof fromY === 'number')
            ? Math.round(toY - fromY) : '?';
        const fr = typeof fromY === 'number' ? Math.round(fromY) : '?';
        const to = typeof toY === 'number' ? Math.round(toY) : '?';
        // from→to is always the computed ABSOLUTE target (scrollBy already resolved).
        const line = (blocked ? '!!! BLK ' : 'WR  ') + kind + ' ' + who + ' ' +
            fr + '→' + to + ' d=' + d;
        if (blocked) dbgLastBlk = line;
        dbgPush(line);
    }

    const markGesture = () => {
        lastGestureAt = Date.now();
        momentumUntil = Date.now() + MOMENTUM_ARM_MS;
    };
    g.addEventListener('wheel', markGesture, true);
    g.addEventListener('touchstart', function (e) {
        markGesture();
        if (!DEBUG) return;
        dbgTouching = true;
        dbgMomentumMarked = false;
        try {
            dbgTouchLastY = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
        } catch (_) { dbgTouchLastY = 0; }
        dbgPush('touchstart y=' + Math.round(currentY()));
    }, true);
    g.addEventListener('touchmove', function (e) {
        markGesture();
        if (!DEBUG) return;
        try {
            if (e.touches && e.touches[0]) dbgTouchLastY = e.touches[0].clientY;
        } catch (_) { /* ignore */ }
    }, true);
    g.addEventListener('touchend', function () {
        if (!DEBUG) return;
        dbgTouching = false;
        dbgPush('touchend y=' + Math.round(currentY()));
    }, true);
    g.addEventListener('touchcancel', function () {
        if (!DEBUG) return;
        dbgTouching = false;
        dbgPush('touchcancel');
    }, true);
    g.addEventListener('pointerdown', markGesture, true);
    g.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            markGesture();
        }
    }, true);

    g.addEventListener('scroll', () => {
        if (Date.now() < momentumUntil) {
            momentumUntil = Date.now() + MOMENTUM_EXTEND_MS;
        }
        if (!DEBUG) return;
        const y = currentY();
        const dy = y - dbgLastScrollY;
        const abs = dy < 0 ? -dy : dy;
        // Unexplained jump: single-frame delta >> recent frame delta, and >30px,
        // while not actively dragging (momentum or programmatic).
        if (!dbgTouching && abs > 30) {
            const prev = dbgLastFrameDy < 0 ? -dbgLastFrameDy : dbgLastFrameDy;
            if (prev < 1 || abs > prev * 3) {
                const ours = isOurWrite();
                // No matching WR line usually means the browser moved scrollY
                // itself (overflow-anchor), not AbsolutePower scrollBy.
                const tag = ours ? (' us:' + ours) : (dbgLastBlk ? ' afterBLK' : ' native?');
                dbgPush('JUMP d=' + Math.round(dy) + ' ' + Math.round(dbgLastScrollY) +
                    '→' + Math.round(y) + tag);
            }
        }
        if (!dbgTouching && Date.now() < momentumUntil && !dbgMomentumMarked && abs < 1.5) {
            // fling likely ended (scroll events trickle with tiny dy)
            dbgMomentumMarked = true;
            dbgPush('momentum-end? y=' + Math.round(y));
        }
        if (abs >= 1.5) dbgMomentumMarked = false;
        dbgLastFrameDy = dy;
        dbgLastScrollY = y;
    }, true);

    g.addEventListener('message', (e) => {
        if (e.source !== g) return;
        const data = e.data;
        if (!data || data.source !== 'tps' || data.type !== 'allow-scroll') return;
        const until = Number(data.until) || 0;
        if (until > g.__tpsAllowScrollUntil) g.__tpsAllowScrollUntil = until;
    });

    function allowUntilFromDom() {
        try {
            const raw = g.document?.documentElement?.getAttribute('data-tps-allow-scroll');
            const until = raw ? Number(raw) : 0;
            if (until > g.__tpsAllowScrollUntil) g.__tpsAllowScrollUntil = until;
        } catch (_) { /* ignore */ }
    }

    function isAllowed() {
        allowUntilFromDom();
        const now = Date.now();
        return now < g.__tpsAllowScrollUntil ||
            now - lastGestureAt < USER_GRACE_MS ||
            now < momentumUntil;
    }

    function currentY() {
        try {
            const doc = g.document;
            const se = doc && (doc.scrollingElement || doc.documentElement);
            return (se && se.scrollTop) || g.scrollY || g.pageYOffset || 0;
        } catch (_) {
            return 0;
        }
    }

    // nextY is always an ABSOLUTE document scroll position.
    // For scrollBy, callers must pass currentY()+delta (see wrapScrollFn isDelta).
    function shouldBlockJumpTo(nextY) {
        if (typeof nextY !== 'number' || !isFinite(nextY) || isAllowed()) return false;
        const cur = currentY();
        if (cur < MID_FEED_Y) return false;
        // Negative absolute Y is not a real jump target (likely a misread delta).
        if (nextY < 0) return false;
        if (nextY <= TOP_TARGET_Y) return true;
        if (cur - nextY >= BIG_JUMP_PX && nextY < (g.innerHeight || 800)) return true;
        return false;
    }

    function parseScrollArgs(args) {
        if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            // scrollTo({top}) / scrollBy({top}) / scroll({top, behavior})
            return { left: args[0].left, top: args[0].top, opts: args[0] };
        }
        return { left: args[0], top: args[1], opts: null };
    }

    // Resolve the absolute Y a scroll write would land on.
    // isDelta=true for scrollBy (window + Element): top is a DELTA, not absolute.
    function resolveScrollTargetY(fromY, top, isDelta) {
        if (typeof top !== 'number' || !isFinite(top)) return null;
        return isDelta ? (fromY + top) : top;
    }

    function wrapScrollFn(kind, orig, isDelta) {
        return function (...args) {
            const from = currentY();
            const { top } = parseScrollArgs(args);
            const nextY = resolveScrollTargetY(from, top, !!isDelta);
            const ours = isOurWrite();
            // Small mid-feed relative corrections (AbsolutePower normalize) must pass.
            let block = false;
            if (typeof nextY === 'number') {
                if (isDelta && nextY > TOP_TARGET_Y &&
                    Math.abs(nextY - from) < BIG_JUMP_PX) {
                    block = false;
                } else {
                    block = shouldBlockJumpTo(nextY);
                }
            }
            if (DEBUG) dbgLogWrite(kind, from, nextY, block, ours);
            if (block) return;
            return orig.apply(this, args);
        };
    }

    try {
        g.scrollTo = wrapScrollFn('scrollTo', g.scrollTo.bind(g), false);
        g.scroll = wrapScrollFn('scroll', g.scroll.bind(g), false);
        g.scrollBy = wrapScrollFn('scrollBy', g.scrollBy.bind(g), true);
    } catch (_) { /* ignore */ }

    // AbsolutePower may scroll a DOM viewport via Element.scrollBy({top:delta}).
    try {
        if (g.Element && g.Element.prototype) {
            const ep = g.Element.prototype;
            if (typeof ep.scrollBy === 'function') {
                ep.scrollBy = wrapScrollFn('el.scrollBy', ep.scrollBy, true);
            }
            if (typeof ep.scrollTo === 'function') {
                ep.scrollTo = wrapScrollFn('el.scrollTo', ep.scrollTo, false);
            }
            if (typeof ep.scroll === 'function') {
                ep.scroll = wrapScrollFn('el.scroll', ep.scroll, false);
            }
        }
    } catch (_) { /* ignore */ }

    try {
        const origSIV = g.Element.prototype.scrollIntoView;
        g.Element.prototype.scrollIntoView = function (...args) {
            const from = currentY();
            let nextY = null;
            try {
                const rect = this.getBoundingClientRect();
                nextY = from + rect.top;
            } catch (_) { /* ignore */ }
            const ours = isOurWrite();
            let block = false;
            if (!isAllowed() && typeof nextY === 'number') {
                block = shouldBlockJumpTo(Math.max(0, nextY));
            }
            if (DEBUG) dbgLogWrite('siv', from, nextY, block, ours);
            if (block) return;
            return origSIV.apply(this, args);
        };
    } catch (_) { /* ignore */ }

    function patchScrollTop(proto) {
        if (!proto) return;
        const desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
        if (!desc || !desc.set || !desc.get || desc.configurable === false) return;
        try {
            Object.defineProperty(proto, 'scrollTop', {
                configurable: true,
                enumerable: desc.enumerable,
                get() { return desc.get.call(this); },
                set(value) {
                    const next = Number(value);
                    const from = currentY();
                    let block = false;
                    let isDocScroller = false;
                    try {
                        const doc = g.document;
                        const se = doc && (doc.scrollingElement || doc.documentElement);
                        isDocScroller = (this === se || this === doc.documentElement ||
                            this === doc.body);
                        if (isDocScroller && shouldBlockJumpTo(next)) {
                            block = true;
                        }
                    } catch (_) { /* fall through */ }
                    if (DEBUG && isDocScroller) {
                        dbgLogWrite('scrollTop', from, next, block, isOurWrite());
                    }
                    if (block) return;
                    desc.set.call(this, value);
                }
            });
        } catch (_) { /* ignore */ }
    }

    try {
        patchScrollTop(g.Element.prototype);
        patchScrollTop(g.HTMLElement && g.HTMLElement.prototype);
    } catch (_) { /* ignore */ }

    // Always honor noanchor flag in page realm (even if scroll debug overlay is off),
    // so Chrome tests can disable native overflow-anchor like iOS.
    try { ensureNoAnchorCss(); } catch (_) { /* ignore */ }

    if (DEBUG) {
        dbgLastScrollY = currentY();
        try {
            if (g.document && g.document.documentElement) {
                dbgEnsureOverlay();
            } else if (g.document) {
                g.document.addEventListener('DOMContentLoaded', function () {
                    ensureNoAnchorCss();
                    dbgEnsureOverlay();
                }, { once: true });
            }
        } catch (_) { /* ignore */ }
    }
}
/* TPS_SCROLL_GUARD_END */

/* TPS_JUMP_HOOK_BEGIN */
// Page-realm fetch/XHR rewrite (Tampermonkey: unsafeWindow; Gear: injected <script>).
// 1) Pending data-tps-jump → first ListLatestTweetsTimeline without cursor is
//    intercepted: the hook fetches the live head + Bottom-cursor pages until the
//    saved position is covered (+ one page below), then delivers ONE merged
//    TimelineAddEntries response so scrolling up/down is native and gap-free.
// 2) If the target is not reached within the page cap, fall back to a single
//    Bottom-cursor jump near the target (v3.28) and keep Top→Bottom fill-up.
// 3) After a non-merged jump, Top cursor (type 1) requests are rewritten to
//    Bottom with B' = B_top + delta (fill-up). Disabled when jump was merged.
// 4) Every ListLatestTweetsTimeline response is scanned for displayedTweetId →
//    positionId mappings and published to <script id="tps-sortmap"> (plus
//    order/jumpMerged/pages after a merge).
function tpsInstallPageJumpHook(globalObj, realmHint, versionHint) {
    'use strict';
    const g = globalObj || (typeof window !== 'undefined' ? window : null);
    if (!g) return;
    const realm = realmHint || 'local';
    const ver = versionHint || '0';

    // Prefer page realm (main / war / injected / tm) over content-script-local.
    // Same-realm double-patch is blocked by __tpsJumpHookInstalled.
    try {
        const existing = g.document && g.document.documentElement &&
            g.document.documentElement.getAttribute('data-tps-hook');
        if (existing) {
            const er = String(existing).split('|')[1] || '';
            const pageRealms = { main: 1, war: 1, injected: 1, tm: 1 };
            if (realm === 'local' && pageRealms[er]) return;
            if (er === realm && g.__tpsJumpHookInstalled) return;
        }
    } catch (_) { /* ignore */ }
    if (g.__tpsJumpHookInstalled) return;
    g.__tpsJumpHookInstalled = true;

    try {
        if (g.document && g.document.documentElement) {
            g.document.documentElement.setAttribute('data-tps-hook', String(ver) + '|' + realm);
        }
    } catch (_) { /* ignore */ }

    const TWITTER_EPOCH_MS = 1288834974657n;
    const SORTMAP_MAX = 600;
    // v3.42: merge-from-head is bounded by a POST budget, not a page count:
    // X serves 20/page on initial+Bottom requests (40 on Top), so 120 posts
    // = 6 pages at 20/page or 3 pages at 40/page.
    const DEFAULT_MERGE_MAX_POSTS = 120;
    const DEFAULT_WINDOW_PAGES_ABOVE = 2;
    // Contiguous step: aim the next Bottom cursor ~75% of a page above the
    // newest known post so the response overlaps what we already have.
    const STEP_SPAN_NUM = 3n;
    const STEP_SPAN_DEN = 4n;
    const STEP_MAX_TRIES = 16;
    const STEP_MAX_WALK = 3;
    const WINDOW_FETCHES_PER_PAGE = 6;
    // Fill-up: X asks for newer posts at most once a minute (near-top fetch
    // is onlyIfStale against the last initial/Top response, 60 s) and only
    // when the viewport ENTERS the top zone. v3.43: contiguous pages above are
    // prefetched in the background, and each answered Top request carries a
    // big chunk so one or two requests reach "now".
    const FILL_POSTS_PER_RESPONSE = 400;
    const FILL_PREFETCH_POSTS = 400;
    const FILL_PREFETCH_DELAY_MS = 1500;
    const FILL_PREFETCH_GAP_MS = 120;
    const FILL_RESPONSE_WAIT_MS = 8000;
    const FILL_RESPONSE_MAX_WAIT_MS = 20000;
    const FILL_MAX_STEPS = 400;
    const FILL_MAX_FAIL_STREAK = 3;
    // v3.44: one background page fetch may not hang the pump forever.
    const FILL_FETCH_TIMEOUT_MS = 15000;
    const FILL_LOG_MAX = 16;
    const NEAR_TOP_RECHECK_MS = 300;
    const SF_PER_MS = 1n << 22n;
    const MIN_SF_PER_POST = 1000n * SF_PER_MS; // 1 s / post
    const MAX_SF_PER_POST = 6n * 3600n * 1000n * SF_PER_MS; // 6 h / post
    const DEFAULT_SF_PER_POST = 4n * 60n * 1000n * SF_PER_MS; // ~4 min / post
    const NOW_MARGIN_SF = 60n * 1000n * SF_PER_MS; // clock skew

    // Survives for the document lifetime once a jump response was served.
    // { mode: 'merged'|'window'|'single', fillUp, fillDone, fillState, steps,
    //   A, sf, lastTopEntry, skeleton }
    let jumpSession = null;
    let fillBusy = false;

    // displayedTweetId → positionId (string). Keep max on collision.
    const sortMap = new Map();
    const sortMapOrder = []; // insertion order for eviction
    let lastJumpMeta = null; // { order, jumpMerged, pages }

    function jumpLog() {
        try {
            const args = Array.prototype.slice.call(arguments);
            args.unshift('[TPS jump]');
            console.log.apply(console, args);
        } catch (_) { /* ignore */ }
    }

    function snowflakeFromMs(ms) {
        return (BigInt(ms) - TWITTER_EPOCH_MS) << 22n;
    }

    function writeU64BE(view, offset, value) {
        const v = BigInt(value);
        view.setUint32(offset, Number((v >> 32n) & 0xffffffffn));
        view.setUint32(offset + 4, Number(v & 0xffffffffn));
    }

    function readU64BE(view, offset) {
        const hi = BigInt(view.getUint32(offset));
        const lo = BigInt(view.getUint32(offset + 4));
        return (hi << 32n) | lo;
    }

    function encodeListCursor(aBig, bBig, type) {
        const buf = new Uint8Array(34);
        const view = new DataView(buf.buffer);
        let i = 0;
        buf[i++] = 0x0c;
        view.setUint16(i, 1); i += 2;
        buf[i++] = 0x0a;
        view.setUint16(i, 1); i += 2;
        writeU64BE(view, i, aBig); i += 8;
        buf[i++] = 0x0a;
        view.setUint16(i, 2); i += 2;
        writeU64BE(view, i, bBig); i += 8;
        buf[i++] = 0x08;
        view.setUint16(i, 3); i += 2;
        view.setInt32(i, Number(type)); i += 4;
        buf[i++] = 0x00;
        buf[i++] = 0x00;
        let s = '';
        for (let j = 0; j < buf.length; j++) s += String.fromCharCode(buf[j]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function decodeListCursor(str) {
        const pad = '='.repeat((4 - (str.length % 4)) % 4);
        const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        if (buf.length < 34) throw new Error('cursor too short');
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let i = 0;
        if (buf[i++] !== 0x0c) throw new Error('bad struct');
        if (view.getUint16(i) !== 1) throw new Error('bad outer field');
        i += 2;
        if (buf[i++] !== 0x0a) throw new Error('bad A type');
        if (view.getUint16(i) !== 1) throw new Error('bad A field');
        i += 2;
        const A = readU64BE(view, i); i += 8;
        if (buf[i++] !== 0x0a) throw new Error('bad B type');
        if (view.getUint16(i) !== 2) throw new Error('bad B field');
        i += 2;
        const B = readU64BE(view, i); i += 8;
        if (buf[i++] !== 0x08) throw new Error('bad type type');
        if (view.getUint16(i) !== 3) throw new Error('bad type field');
        i += 2;
        const type = view.getInt32(i);
        return { A, B, type };
    }

    function unwrapTweetResult(result) {
        if (!result || typeof result !== 'object') return null;
        if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
            return result.tweet;
        }
        return result;
    }

    function recordSortMapping(displayedId, sortIndex) {
        if (!displayedId || !sortIndex) return;
        const id = String(displayedId);
        const si = String(sortIndex);
        if (!/^\d+$/.test(id) || !/^\d+$/.test(si)) return;
        const prev = sortMap.get(id);
        if (prev != null) {
            try {
                if (BigInt(prev) >= BigInt(si)) return;
            } catch (_) {
                return;
            }
            sortMap.set(id, si);
            return;
        }
        sortMap.set(id, si);
        sortMapOrder.push(id);
        while (sortMapOrder.length > SORTMAP_MAX) {
            const old = sortMapOrder.shift();
            if (old && sortMap.has(old)) sortMap.delete(old);
        }
    }

    function publishSortMap() {
        try {
            const doc = g.document;
            if (!doc) return;
            const obj = {};
            sortMap.forEach((v, k) => { obj[k] = v; });
            if (lastJumpMeta) {
                if (Array.isArray(lastJumpMeta.order)) obj.order = lastJumpMeta.order;
                if (lastJumpMeta.jumpMerged) obj.jumpMerged = true;
                if (lastJumpMeta.pages != null) obj.pages = lastJumpMeta.pages;
            }
            let el = doc.getElementById('tps-sortmap');
            if (!el) {
                el = doc.createElement('script');
                el.type = 'application/json';
                el.id = 'tps-sortmap';
                (doc.documentElement || doc.head || doc.body).appendChild(el);
            }
            el.textContent = JSON.stringify(obj);
        } catch (_) { /* ignore */ }
    }

    // Pure: walk TimelineAddEntries → { sortIndexes, pairs, tweets, topCursor, bottomCursor, positionIds }
    function extractSortMapFromListJson(json) {
        const sortIndexes = [];
        const pairs = [];
        const tweets = [];
        let topCursor = null;
        let bottomCursor = null;
        try {
            const tl = json && json.data && json.data.list &&
                json.data.list.tweets_timeline && json.data.list.tweets_timeline.timeline;
            const instructions = tl && tl.instructions;
            if (!Array.isArray(instructions)) {
                return { sortIndexes, pairs, tweets, topCursor, bottomCursor, positionIds: [] };
            }

            function addFromTweetResult(result, sortIndex) {
                const tweet = unwrapTweetResult(result);
                if (!tweet) return;
                if (tweet.rest_id) pairs.push([String(tweet.rest_id), sortIndex]);
                const rt = tweet.legacy && tweet.legacy.retweeted_status_result &&
                    tweet.legacy.retweeted_status_result.result;
                if (rt) {
                    const inner = unwrapTweetResult(rt);
                    if (inner && inner.rest_id) pairs.push([String(inner.rest_id), sortIndex]);
                }
            }

            for (let i = 0; i < instructions.length; i++) {
                const inst = instructions[i];
                if (!inst || inst.type !== 'TimelineAddEntries' || !Array.isArray(inst.entries)) continue;
                for (let j = 0; j < inst.entries.length; j++) {
                    const ent = inst.entries[j];
                    if (!ent) continue;
                    const eid = ent.entryId;
                    if (typeof eid === 'string' && eid.indexOf('cursor-top-') === 0) {
                        topCursor = ent;
                        continue;
                    }
                    if (typeof eid === 'string' && eid.indexOf('cursor-bottom-') === 0) {
                        bottomCursor = ent;
                        continue;
                    }
                    // Also detect via content.cursorType when entryId shape differs.
                    const ct = ent.content && ent.content.cursorType;
                    if (ct === 'Top') { topCursor = ent; continue; }
                    if (ct === 'Bottom') { bottomCursor = ent; continue; }

                    const sortIndex = ent.sortIndex != null ? String(ent.sortIndex) : null;
                    if (typeof eid !== 'string' || eid.indexOf('tweet-') !== 0 || !sortIndex) continue;
                    if (!/^\d+$/.test(sortIndex)) continue;
                    const result = ent.content && ent.content.itemContent &&
                        ent.content.itemContent.tweet_results &&
                        ent.content.itemContent.tweet_results.result;
                    const outer = unwrapTweetResult(result);
                    const fromEntry = eid.slice(6);
                    const pos = outer && outer.rest_id && /^\d+$/.test(String(outer.rest_id))
                        ? String(outer.rest_id)
                        : (/^\d+$/.test(fromEntry) ? fromEntry : null);
                    if (!pos) continue;
                    sortIndexes.push(BigInt(pos));
                    pairs.push([pos, pos]);
                    if (/^\d+$/.test(fromEntry)) pairs.push([fromEntry, pos]);
                    addFromTweetResult(result, pos);
                    tweets.push(ent);
                }
            }
        } catch (_) { /* ignore */ }
        const positionIds = sortIndexes.map((x) => String(x));
        return { sortIndexes, pairs, tweets, topCursor, bottomCursor, positionIds };
    }

    function pagePassesTarget(positionIds, targetPosId) {
        if (!targetPosId || !positionIds || !positionIds.length) return false;
        try {
            const target = BigInt(String(targetPosId));
            for (let i = 0; i < positionIds.length; i++) {
                if (BigInt(positionIds[i]) === target) return true;
            }
            const oldest = BigInt(positionIds[positionIds.length - 1]);
            return oldest <= target;
        } catch (_) {
            return false;
        }
    }

    // Pure: merge page JSONs (newest-first chain) into one TimelineAddEntries response.
    // Dedupe tweets by entryId, keep server sortIndexes, first top cursor, last bottom cursor.
    function mergeTimelinePages(pageJsons) {
        if (!pageJsons || !pageJsons.length) return null;
        try {
            const base = JSON.parse(JSON.stringify(pageJsons[0]));
            const tl = base && base.data && base.data.list &&
                base.data.list.tweets_timeline && base.data.list.tweets_timeline.timeline;
            if (!tl || !Array.isArray(tl.instructions)) return null;

            let addInst = null;
            for (let i = 0; i < tl.instructions.length; i++) {
                if (tl.instructions[i] && tl.instructions[i].type === 'TimelineAddEntries') {
                    addInst = tl.instructions[i];
                    break;
                }
            }
            if (!addInst) {
                addInst = { type: 'TimelineAddEntries', entries: [] };
                tl.instructions.push(addInst);
            }

            const seen = new Set();
            const mergedTweets = [];
            let topCursor = null;
            let bottomCursor = null;
            const order = [];

            for (let p = 0; p < pageJsons.length; p++) {
                const extracted = extractSortMapFromListJson(pageJsons[p]);
                if (p === 0 && extracted.topCursor) topCursor = extracted.topCursor;
                if (extracted.bottomCursor) bottomCursor = extracted.bottomCursor;
                for (let t = 0; t < extracted.tweets.length; t++) {
                    const ent = extracted.tweets[t];
                    const eid = ent && ent.entryId;
                    if (!eid || seen.has(eid)) continue;
                    seen.add(eid);
                    mergedTweets.push(ent);
                }
                for (let i = 0; i < extracted.positionIds.length; i++) {
                    const pid = extracted.positionIds[i];
                    if (order.length && order[order.length - 1] === pid) continue;
                    // Dedupe order by first occurrence (newest pages first).
                    if (order.indexOf(pid) === -1) order.push(pid);
                }
            }

            const entries = mergedTweets.slice();
            if (topCursor) entries.push(topCursor);
            if (bottomCursor) entries.push(bottomCursor);
            addInst.entries = entries;

            // Drop other TimelineAddEntries to avoid duplicate instructions.
            tl.instructions = tl.instructions.filter((inst, idx) => {
                if (!inst || inst.type !== 'TimelineAddEntries') return true;
                return inst === addInst;
            });

            return { json: base, order: order, tweetCount: mergedTweets.length };
        } catch (_) {
            return null;
        }
    }

    // ---- v3.42 pure planning helpers (exported for tests) ----

    function clampSf(v) {
        if (v == null) return null;
        if (v < MIN_SF_PER_POST) return MIN_SF_PER_POST;
        if (v > MAX_SF_PER_POST) return MAX_SF_PER_POST;
        return v;
    }

    // Average snowflake distance between consecutive posts on a page.
    function estimateSfPerPost(positionIds) {
        try {
            if (!positionIds || positionIds.length < 2) return null;
            const newest = BigInt(positionIds[0]);
            const oldest = BigInt(positionIds[positionIds.length - 1]);
            if (newest <= oldest) return null;
            return clampSf((newest - oldest) / BigInt(positionIds.length - 1));
        } catch (_) {
            return null;
        }
    }

    function listPageSize(urlStr, fallback) {
        const vars = parseListVariables(urlStr);
        const n = vars && Number(vars.count);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
        return fallback || 20;
    }

    function mergePageBudget(maxPosts, pageSize) {
        const posts = Number(maxPosts) > 0 ? Number(maxPosts) : DEFAULT_MERGE_MAX_POSTS;
        const size = Number(pageSize) > 0 ? Number(pageSize) : 20;
        return Math.max(2, Math.floor(posts / size));
    }

    // Decide merge-from-head vs. bounded window around the target, from the
    // head page alone (density-aware). Returns { mode, estPosts, estPages, maxPages }.
    function planJumpStrategy(headIds, targetPos, pageSize, maxPosts, sfHint) {
        const size = Number(pageSize) > 0 ? Number(pageSize) : 20;
        const maxPages = mergePageBudget(maxPosts, size);
        if (!targetPos) return { mode: 'single', estPosts: 0, estPages: 0, maxPages };
        if (!headIds || !headIds.length) return { mode: 'window', estPosts: -1, estPages: -1, maxPages };
        if (pagePassesTarget(headIds, targetPos)) {
            return { mode: 'merge', estPosts: headIds.length, estPages: 2, maxPages };
        }
        const sf = estimateSfPerPost(headIds) || clampSf(sfHint) || DEFAULT_SF_PER_POST;
        const oldest = BigInt(headIds[headIds.length - 1]);
        const target = BigInt(String(targetPos));
        const below = Number((oldest - target) / sf) + 1;
        const estPosts = headIds.length + below;
        // +1 page past the target (context below it).
        const estPages = Math.ceil(estPosts / size) + 1;
        return { mode: estPages <= maxPages ? 'merge' : 'window', estPosts, estPages, maxPages };
    }

    // Where to aim the next Bottom cursor above the newest known post K.
    function nextStepCursorB(K, spanSf, nowSf) {
        const cap = nowSf + NOW_MARGIN_SF;
        let B = K + (spanSf > 0n ? spanSf : 1n);
        if (B >= cap) return { B: cap, atNow: true };
        return { B, atNow: false };
    }

    // A Bottom page fetched at B is contiguous with K iff it reaches down to K.
    function classifyStep(positionIds, K) {
        if (!positionIds || !positionIds.length) return 'empty';
        let newer = 0;
        for (let i = 0; i < positionIds.length; i++) {
            if (BigInt(positionIds[i]) > K) newer++;
        }
        const oldest = BigInt(positionIds[positionIds.length - 1]);
        if (oldest <= K) return newer ? 'contiguous' : 'empty';
        return 'gap';
    }

    // One contiguous step above K. fetchAtB(B) → { json, ids } | null.
    // Returns { ok, pages (newest first), newIds (newest first), atNow, tries,
    // floorB, reason }.
    // Find Bottom cursors whose pages (the newest `pageSize` posts older than
    // B) join up with K:
    //  - "empty" proves (K, B) has no posts → raise the floor `lo`;
    //  - "gap" returns a full page ending at a post O newer than K. Walk down
    //    from it (cursor O+1 returns O and the page below, so the pages chain
    //    without holes) until a page reaches K — every walked page is used.
    //    After STEP_MAX_WALK pages, search between lo and the lowest O
    //    instead (half a page below O at the local density, doubling, never
    //    below the midpoint); after an "empty" there, probe O+1 again.
    // `floorB` (optional): a cursor known to have no posts in (K, floorB) —
    // the previous step's result — so the next step starts above it.
    async function stepAbove(fetchAtB, K, sfPerPost, pageSize, nowSf, floorB) {
        const size = BigInt(Math.max(1, Number(pageSize) || 20));
        let span = ((clampSf(sfPerPost) || DEFAULT_SF_PER_POST) * size * STEP_SPAN_NUM) / STEP_SPAN_DEN;
        let lo = K;        // no posts in (K, lo)
        if (typeof floorB === 'bigint' && floorB > K) lo = floorB;
        let oMin = null;   // lowest post above K that a gap page ended at
        let chain = [];    // gap pages newest-first, contiguous down to oMin
        let walks = 0;
        let gaps = 0;      // consecutive gaps in search mode
        let localSf = null;
        for (let tries = 1; tries <= STEP_MAX_TRIES; tries++) {
            let aim;
            let walking = false;
            if (oMin == null) {
                aim = nextStepCursorB(lo, span, nowSf);
            } else if (lo >= oMin || gaps === 0 || (chain.length && walks < STEP_MAX_WALK)) {
                // The cursor just above oMin returns oMin itself: contiguous
                // with K, or one more chained page.
                aim = { B: oMin + 1n, atNow: false };
                walking = true;
            } else {
                const mid = lo + (oMin - lo) / 2n;
                let cand = mid;
                if (gaps > 0 && localSf) {
                    const d = (localSf * size / 2n) * (1n << BigInt(Math.min(gaps - 1, 30)));
                    const c2 = oMin - d;
                    if (c2 > mid) cand = c2;
                }
                aim = cand > lo ? { B: cand, atNow: false } : { B: oMin + 1n, atNow: false };
                walking = aim.B === oMin + 1n;
            }
            const page = await fetchAtB(aim.B);
            if (!page) return { ok: false, reason: 'fetch', tries };
            const c = classifyStep(page.ids, K);
            if (c === 'contiguous') {
                // This page holds every post in (K, B); joined with the chain
                // it holds every post in (K, chain[0].B).
                const pages = (walking && chain.length) ? chain.concat([page]) : [page];
                const seen = new Set();
                const newIds = [];
                for (let p = 0; p < pages.length; p++) {
                    for (let i = 0; i < pages[p].ids.length; i++) {
                        const id = pages[p].ids[i];
                        if (BigInt(id) > K && !seen.has(String(id))) { seen.add(String(id)); newIds.push(id); }
                    }
                }
                newIds.sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
                const top = pages.length > 1 ? chain[0].B : aim.B;
                return { ok: true, pages, page: pages[0], newIds, atNow: pages.length > 1 ? chain[0].atNow : aim.atNow,
                    tries, floorB: top };
            }
            if (c === 'empty') {
                if (aim.atNow) return { ok: true, pages: [page], page, newIds: [], atNow: true, tries, floorB: aim.B };
                if (aim.B > lo) lo = aim.B;
                if (oMin == null) span *= 2n;
                gaps = 0;
                continue;
            }
            const O = BigInt(page.ids[page.ids.length - 1]);
            page.B = aim.B;
            page.atNow = aim.atNow;
            if (walking && chain.length) {
                chain.push(page);
                walks++;
            } else {
                chain = [page];   // a new root page (search result)
                gaps++;
            }
            if (chain.length > STEP_MAX_WALK + 1) chain = [];
            if (oMin == null || O < oMin) oMin = O;
            localSf = clampSf(estimateSfPerPost(page.ids)) || localSf || clampSf(sfPerPost) || DEFAULT_SF_PER_POST;
        }
        return { ok: false, reason: 'tries', tries: STEP_MAX_TRIES };
    }

    function timelineOf(json) {
        return json && json.data && json.data.list &&
            json.data.list.tweets_timeline && json.data.list.tweets_timeline.timeline;
    }

    // Empty response shaped like a real one (keeps metadata etc.).
    function skeletonFrom(json) {
        try {
            const base = JSON.parse(JSON.stringify(json));
            const tl = timelineOf(base);
            if (!tl) return null;
            tl.instructions = [{ type: 'TimelineAddEntries', entries: [] }];
            return base;
        } catch (_) {
            return null;
        }
    }

    function defaultSkeleton() {
        return {
            data: { list: { tweets_timeline: { timeline: {
                instructions: [{ type: 'TimelineAddEntries', entries: [] }],
                metadata: {}
            } } } }
        };
    }

    function makeTopCursorEntry(template, value, newestPos) {
        const sortIndex = String(BigInt(newestPos) + 1n);
        let ent = null;
        try {
            if (template) ent = JSON.parse(JSON.stringify(template));
        } catch (_) { ent = null; }
        if (!ent || !ent.content) {
            ent = {
                entryId: '',
                sortIndex: '',
                content: {
                    entryType: 'TimelineTimelineCursor',
                    __typename: 'TimelineTimelineCursor',
                    value: '',
                    cursorType: 'Top'
                }
            };
        }
        ent.entryId = 'cursor-top-' + sortIndex;
        ent.sortIndex = sortIndex;
        if (ent.content.itemContent && typeof ent.content.itemContent.value === 'string') {
            ent.content.itemContent.value = value;
        } else {
            ent.content.value = value;
        }
        ent.content.cursorType = 'Top';
        return ent;
    }

    // Build a response: tweets newer than minExclusive from pages (newest
    // first), plus a synthetic Top cursor at newest. No Bottom cursor unless
    // keepBottom is given (the window keeps P0's real bottom cursor).
    function buildTimelineResponse(skeleton, pages, minExclusive, A, topTemplate, keepBottom) {
        const base = JSON.parse(JSON.stringify(skeleton || defaultSkeleton()));
        const tl = timelineOf(base);
        const seen = new Set();
        const tweets = [];
        const order = [];
        let newest = null;
        for (let p = 0; p < pages.length; p++) {
            const ex = extractSortMapFromListJson(pages[p]);
            for (let t = 0; t < ex.tweets.length; t++) {
                const pos = BigInt(ex.positionIds[t]);
                if (minExclusive != null && pos <= minExclusive) continue;
                const ent = ex.tweets[t];
                if (!ent || !ent.entryId || seen.has(ent.entryId)) continue;
                seen.add(ent.entryId);
                tweets.push(ent);
                if (order.indexOf(ex.positionIds[t]) === -1) order.push(ex.positionIds[t]);
                if (newest == null || pos > newest) newest = pos;
            }
        }
        const top = newest != null
            ? makeTopCursorEntry(topTemplate, encodeListCursor(A, newest, 1), newest)
            : null;
        const entries = tweets.slice();
        if (top) entries.push(top);
        if (keepBottom) entries.push(keepBottom);
        tl.instructions = [{ type: 'TimelineAddEntries', entries }];
        return { json: base, order, tweetCount: tweets.length, newest, topEntry: top };
    }

    function inspectResponseText(text) {
        if (!text) return;
        try {
            const json = JSON.parse(text);
            const extracted = extractSortMapFromListJson(json);
            for (let i = 0; i < extracted.pairs.length; i++) {
                recordSortMapping(extracted.pairs[i][0], extracted.pairs[i][1]);
            }
            if (extracted.pairs.length || lastJumpMeta) publishSortMap();
        } catch (_) { /* ignore */ }
    }

    function readPendingJump() {
        try {
            const raw = g.document && g.document.documentElement &&
                g.document.documentElement.getAttribute('data-tps-jump');
            if (!raw) return null;
            const parts = String(raw).split('|');
            if (parts.length < 3) return null;
            const B = BigInt(parts[0]);
            const A = BigInt(parts[1]);
            const expires = Number(parts[2]);
            if (!Number.isFinite(expires) || Date.now() > expires) return null;
            const fillUp = parts.length < 4 ? true : parts[3] !== '0';
            let targetPos = null;
            if (parts.length >= 5 && /^\d+$/.test(parts[4])) targetPos = parts[4];
            // v3.42: field 6 is a post budget for merge-from-head.
            let maxPosts = DEFAULT_MERGE_MAX_POSTS;
            if (parts.length >= 6) {
                const n = Number(parts[5]);
                if (Number.isFinite(n) && n > 0) maxPosts = Math.floor(n);
            }
            let windowAbove = DEFAULT_WINDOW_PAGES_ABOVE;
            if (parts.length >= 7) {
                const n = Number(parts[6]);
                if (Number.isFinite(n) && n >= 0) windowAbove = Math.min(4, Math.floor(n));
            }
            return { A, B, fillUp, targetPos, maxPosts, windowAbove };
        } catch (_) {
            return null;
        }
    }

    // v3.44: short log of fill events for the on-phone debug view (the
    // content script shows it on a long-press of the fill pill).
    const fillLogRing = [];
    function fillEvent(msg) {
        try {
            fillLogRing.push(Date.now() + '|' + String(msg).slice(0, 120));
            while (fillLogRing.length > FILL_LOG_MAX) fillLogRing.shift();
            g.document.documentElement.setAttribute('data-tps-fill-log', JSON.stringify(fillLogRing));
        } catch (_) { /* ignore */ }
    }

    function setFillState(state) {
        const prev = jumpSession ? jumpSession.fillState : null;
        if (jumpSession) jumpSession.fillState = state;
        if (String(state) !== String(prev)) fillEvent('fill state ' + state);
        try { g.document.documentElement.setAttribute('data-tps-fill', String(state)); } catch (_) { /* ignore */ }
    }

    function startJumpSession(opts) {
        const mode = opts.mode;
        const positioned = mode === 'merged' || mode === 'window';
        jumpSession = {
            mode,
            // Merge-from-head is already contiguous up to "now": no fill.
            fillUp: mode !== 'merged' && opts.fillUp !== false,
            fillDone: !!opts.atNow,
            fillState: null,
            steps: 0,
            holds: 0,
            A: opts.A,
            sf: opts.sf || null,
            floor: opts.floor || null,  // { K, B }: no posts in (K, B) (carry to next step)
            lastTopEntry: opts.lastTopEntry || null,
            skeleton: opts.skeleton || null,
            // v3.43 prefetch buffer: contiguous chunks of posts newer than
            // `base` (X's current Top cursor), oldest chunk first.
            buf: newFillBuffer(opts.topK != null ? opts.topK : null,
                opts.floor && opts.topK != null && opts.floor.K === opts.topK ? opts.floor.B : null, !!opts.atNow),
            fetcher: opts.fetcher || null,
            pump: null
        };
        markTopFetch();
        try {
            const el = g.document.documentElement;
            el.removeAttribute('data-tps-jump');
            el.setAttribute('data-tps-jump-used', String(Date.now()));
            el.setAttribute('data-tps-jump-session', positioned ? 'merged' : '1');
            el.setAttribute('data-tps-jump-mode', mode);
            if (positioned) el.setAttribute('data-tps-jump-merged', '1');
            else el.removeAttribute('data-tps-jump-merged');
            el.removeAttribute('data-tps-jump-busy');
        } catch (_) { /* ignore */ }
        if (!jumpSession.fillUp) setFillState('off');
        else setFillState(jumpSession.fillDone ? 'now' : 'armed');
    }

    function urlWithCursor(urlStr, cursor) {
        const u = new URL(urlStr, g.location.href);
        const varsRaw = u.searchParams.get('variables');
        if (!varsRaw) return null;
        const vars = JSON.parse(varsRaw);
        if (cursor == null || cursor === '') delete vars.cursor;
        else vars.cursor = cursor;
        u.searchParams.set('variables', JSON.stringify(vars));
        return u.toString();
    }

    function parseListVariables(urlStr) {
        try {
            const u = new URL(urlStr, g.location.href);
            const varsRaw = u.searchParams.get('variables');
            if (!varsRaw) return null;
            return JSON.parse(varsRaw);
        } catch (_) {
            return null;
        }
    }

    function isCursorlessListUrl(urlStr) {
        const vars = parseListVariables(urlStr);
        return !!(vars && (vars.cursor == null || vars.cursor === ''));
    }

    function bottomCursorValue(extracted) {
        const ent = extracted && extracted.bottomCursor;
        if (!ent) return null;
        try {
            if (ent.content && typeof ent.content.value === 'string') return ent.content.value;
            if (ent.content && ent.content.itemContent && typeof ent.content.itemContent.value === 'string') {
                return ent.content.itemContent.value;
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    function isListTimelineUrl(url) {
        return typeof url === 'string' && url.indexOf('/ListLatestTweetsTimeline') !== -1;
    }

    function headersToObject(headerPairs) {
        const out = {};
        if (!headerPairs) return out;
        for (let i = 0; i < headerPairs.length; i++) {
            const pair = headerPairs[i];
            if (!pair || pair.length < 2) continue;
            out[pair[0]] = pair[1];
        }
        return out;
    }

    function omitTransactionId(headerObj) {
        const out = {};
        const keys = Object.keys(headerObj || {});
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (k && k.toLowerCase() === 'x-client-transaction-id') continue;
            out[k] = headerObj[k];
        }
        return out;
    }

    async function fetchListPageOnce(url, headerObj, useTransactionId) {
        const headers = useTransactionId ? headerObj : omitTransactionId(headerObj);
        const init = {
            method: 'GET',
            headers: headers,
            credentials: 'include',
            cache: 'no-store'
        };
        if (typeof origFetch === 'function') {
            const res = await origFetch.call(g, url, init);
            const text = await res.text();
            return { ok: res.ok, status: res.status, text: text, url: res.url || url };
        }
        // Fallback: fresh XHR
        return await new Promise((resolve, reject) => {
            try {
                const xhr = new XHR();
                xhr.open('GET', url, true);
                xhr.withCredentials = true;
                const keys = Object.keys(headers || {});
                for (let i = 0; i < keys.length; i++) {
                    try { xhr.setRequestHeader(keys[i], headers[keys[i]]); } catch (_) { /* ignore */ }
                }
                xhr.onload = function () {
                    resolve({
                        ok: xhr.status >= 200 && xhr.status < 300,
                        status: xhr.status,
                        text: xhr.responseText,
                        url: xhr.responseURL || url
                    });
                };
                xhr.onerror = function () { reject(new Error('xhr network error')); };
                xhr.send();
            } catch (e) {
                reject(e);
            }
        });
    }

    async function fetchListPage(url, headerObj) {
        let result = await fetchListPageOnce(url, headerObj, true);
        if (!result.ok) {
            jumpLog('page fetch status', result.status, '— retry without x-client-transaction-id');
            result = await fetchListPageOnce(url, headerObj, false);
        }
        return result;
    }

    // Cap / stop-condition decision helper (exported for tests).
    function mergeStopDecision(pagesFetched, reachedAt, maxPages, hasBottom) {
        if (pagesFetched >= maxPages) return 'cap';
        if (reachedAt >= 0 && pagesFetched > reachedAt + 1) return 'done';
        if (!hasBottom) return reachedAt >= 0 ? 'done' : 'no-bottom';
        return 'continue';
    }

    async function collectMergedPages(headUrl, headerObj, targetPos, maxPages, firstJson) {
        const pages = [];
        let reachedAt = -1;
        let url = headUrl;
        let lastStatus = 0;

        while (pages.length < maxPages) {
            let json;
            if (firstJson && !pages.length) {
                json = firstJson; // v3.42: head page already fetched for planning
            } else {
                jumpLog('fetching page', pages.length + 1, '/', maxPages, reachedAt >= 0 ? '(past target, +1)' : '');
                const result = await fetchListPage(url, headerObj);
                lastStatus = result.status;
                if (!result.ok) {
                    jumpLog('page fetch failed', result.status);
                    return { pages, reachedAt, error: 'status-' + result.status, lastStatus };
                }
                try {
                    json = JSON.parse(result.text);
                } catch (e) {
                    return { pages, reachedAt, error: 'bad-json', lastStatus };
                }
            }
            pages.push(json);
            const extracted = extractSortMapFromListJson(json);
            if (reachedAt < 0 && pagePassesTarget(extracted.positionIds, targetPos)) {
                reachedAt = pages.length - 1;
                jumpLog('target reached on page', pages.length,
                    'oldest=', extracted.positionIds[extracted.positionIds.length - 1] || '?');
            }
            const bottomVal = bottomCursorValue(extracted);
            const decision = mergeStopDecision(
                pages.length, reachedAt, maxPages, !!bottomVal
            );
            if (decision === 'done') break;
            if (decision === 'cap') {
                jumpLog('hit page cap', maxPages, 'without target');
                break;
            }
            if (decision === 'no-bottom') {
                jumpLog('no bottom cursor; stopping');
                break;
            }
            const nextUrl = urlWithCursor(headUrl, bottomVal);
            if (!nextUrl) break;
            url = nextUrl;
        }

        return { pages, reachedAt, error: null, lastStatus };
    }

    async function fetchPageJson(url, headerObj) {
        const result = await fetchListPage(url, headerObj);
        if (!result.ok) return { ok: false, status: result.status };
        try {
            const json = JSON.parse(result.text);
            const ex = extractSortMapFromListJson(json);
            return { ok: true, json, ids: ex.positionIds, extracted: ex, status: result.status };
        } catch (_) {
            return { ok: false, status: 'bad-json' };
        }
    }

    function makeFetchAtB(baseUrl, headerObj, A) {
        return async function (B) {
            const url = urlWithCursor(baseUrl, encodeListCursor(A, B, 2));
            if (!url) return null;
            const page = await fetchPageJson(url, headerObj);
            return page.ok ? page : null;
        };
    }

    // v3.42 deep target: Bottom page at the target + N contiguous pages above.
    async function collectWindowPages(headUrl, headerObj, targetPos, A, above, sfHint) {
        const pageSize = listPageSize(headUrl, 20);
        const nowSf = snowflakeFromMs(Date.now());
        const fetchAtB = makeFetchAtB(headUrl, headerObj, A);
        const p0 = await fetchAtB(BigInt(String(targetPos)) + 1n);
        if (!p0) return { ok: false, error: 'p0-fetch' };
        if (!p0.ids.length) return { ok: false, error: 'p0-empty' };
        const pages = [p0.json];
        let K = BigInt(p0.ids[0]);
        let sf = estimateSfPerPost(p0.ids) || clampSf(sfHint) || DEFAULT_SF_PER_POST;
        let atNow = false;
        let steps = 0;
        // `above` pages of context: aim for above×pageSize/2 newer posts
        // (steps are often small in bursty lists), within a fetch budget.
        const wantNewer = Math.ceil(above * pageSize / 2);
        const maxFetches = WINDOW_FETCHES_PER_PAGE * Math.max(1, above);
        let newer = 0;
        let floorB = null;
        let fetches = 0;
        while (newer < wantNewer && fetches < maxFetches && !atNow) {
            const r = await stepAbove(fetchAtB, K, sf, pageSize, nowSf, floorB);
            steps++;
            fetches += r.tries || 1;
            if (!r.ok) { jumpLog('window step failed', r.reason); break; }
            floorB = r.floorB;
            if (r.newIds.length) {
                pages.unshift.apply(pages, r.pages.map((pg) => pg.json));
                K = BigInt(r.newIds[0]);
                newer += r.newIds.length;
                sf = estimateSfPerPost(r.pages[r.pages.length - 1].ids) || sf;
            }
            atNow = r.atNow;
        }
        return { ok: true, pages, K, sf, atNow, steps, p0, floorB };
    }

    function newFillBuffer(base, floorB, atNow) {
        return { base, K: base, floorB: floorB != null ? floorB : null, chunks: [], posts: 0,
            atNow: !!atNow, dead: false, fails: 0, want: 0 };
    }

    // X's near-top fetch is skipped for 60 s after any initial/Top response;
    // the content script uses this to know when a nudge can trigger it.
    function markTopFetch() {
        try { g.document.documentElement.setAttribute('data-tps-top-at', String(Date.now())); } catch (_) { /* ignore */ }
    }

    // One background pump per session: steps up from buf.K until `want`
    // posts are buffered, "now" is reached, or it keeps failing.
    function pumpFill(s) {
        if (!s || s.pump || !s.fetcher || !s.buf || s.buf.base == null) return s && s.pump ? s.pump.done : null;
        const buf = s.buf;
        const token = {};
        s.pump = token; // set before the body runs (it may finish synchronously)
        const run = (async function () {
            await null;
            try {
                while (s === jumpSession && s.fillUp && !s.fillDone && buf === s.buf && !buf.atNow &&
                        !buf.dead && buf.posts < buf.want && s.steps < FILL_MAX_STEPS) {
                    s.steps++;
                    const fetchAtB = s.fetcher.fetchAtB;
                    const timedFetch = (B) => withTimeout(fetchAtB(B), FILL_FETCH_TIMEOUT_MS, () => {
                        fillEvent('page fetch timed out (' + (FILL_FETCH_TIMEOUT_MS / 1000) + ' s)');
                        return null;
                    });
                    const r = await stepAbove(timedFetch, buf.K, s.sf || DEFAULT_SF_PER_POST,
                        s.fetcher.pageSize, snowflakeFromMs(Date.now()), buf.floorB);
                    if (buf !== s.buf) break;
                    if (!r.ok) {
                        buf.fails++;
                        jumpLog('fill step failed', r.reason, 'streak', buf.fails);
                        fillEvent('background step failed (' + r.reason + ') ' + buf.fails + '/' + FILL_MAX_FAIL_STREAK);
                        if (buf.fails >= FILL_MAX_FAIL_STREAK) { buf.dead = true; break; }
                        await sleepMs(1000 * buf.fails);
                        continue;
                    }
                    buf.fails = 0;
                    buf.floorB = r.floorB;
                    if (r.newIds.length) {
                        const K = BigInt(r.newIds[0]);
                        buf.chunks.push({ pages: r.pages.map((pg) => pg.json), K, n: r.newIds.length });
                        buf.K = K;
                        buf.posts += r.newIds.length;
                        s.sf = estimateSfPerPost(r.pages[r.pages.length - 1].ids) || s.sf;
                    }
                    if (r.atNow) buf.atNow = true;
                    try {
                        g.document.documentElement.setAttribute('data-tps-fill-buf',
                            String(buf.posts) + (buf.atNow ? '|now' : ''));
                    } catch (_) { /* ignore */ }
                    await sleepMs(FILL_PREFETCH_GAP_MS);
                }
            } catch (e) {
                jumpLog('fill pump error', e && (e.message || e));
                fillEvent('background error ' + (e && (e.message || e)));
                buf.fails++;
                if (buf.fails >= FILL_MAX_FAIL_STREAK) buf.dead = true;
            } finally {
                if (s.pump === token) s.pump = null;
                // More was asked for while this run was winding down.
                const b = s.buf;
                if (s === jumpSession && s.fillUp && !s.fillDone && b && !b.atNow && !b.dead &&
                        b.posts < b.want && s.steps < FILL_MAX_STEPS) {
                    g.setTimeout(() => pumpFill(s), 0);
                }
            }
        })();
        token.done = run;
        return run;
    }

    function withTimeout(promise, ms, onTimeout) {
        return new Promise((resolve, reject) => {
            let done = false;
            const t = g.setTimeout(() => {
                if (done) return;
                done = true;
                try { resolve(onTimeout()); } catch (e) { reject(e); }
            }, ms);
            Promise.resolve(promise).then((v) => {
                if (done) return;
                done = true; try { (g.clearTimeout || clearTimeout)(t); } catch (_) {}; resolve(v);
            }, (e) => {
                if (done) return;
                done = true; try { (g.clearTimeout || clearTimeout)(t); } catch (_) {}; reject(e);
            });
        });
    }

    function prefetchFill(s) {
        if (!s || !s.buf || s.fillDone || !s.fillUp) return;
        s.buf.want = Math.max(s.buf.want, s.buf.posts + FILL_PREFETCH_POSTS);
        pumpFill(s);
    }

    function holdResponseText() {
        const s = jumpSession;
        const base = JSON.parse(JSON.stringify((s && s.skeleton) || defaultSkeleton()));
        const tl = timelineOf(base);
        tl.instructions = [{ type: 'TimelineAddEntries', entries: s && s.lastTopEntry ? [s.lastTopEntry] : [] }];
        return JSON.stringify(base);
    }

    function userNearTop() {
        try {
            return g.document.documentElement.getAttribute('data-tps-near-top') === '1';
        } catch (_) {
            return false;
        }
    }

    function sessionWantsFill() {
        return !!(jumpSession && jumpSession.fillUp && !jumpSession.fillDone);
    }

    function topCursorOfUrl(urlStr) {
        const vars = parseListVariables(urlStr);
        if (!vars || vars.cursor == null || vars.cursor === '') return null;
        try {
            const d = decodeListCursor(String(vars.cursor));
            return d.type === 1 ? d : null;
        } catch (_) {
            return null;
        }
    }

    function sleepMs(ms) {
        return new Promise((resolve) => {
            try { g.setTimeout(resolve, ms); } catch (_) { setTimeout(resolve, ms); }
        });
    }

    // v3.42 fill-up: answer X's Top request (newer posts) with contiguous
    // pages above its own Top cursor. Never touches the request URL. Returns
    // response text, or null to let the original request through.
    async function handleTopRequest(url, headerObj) {
        const decoded = topCursorOfUrl(url);
        if (!decoded || !sessionWantsFill()) return null;
        const s = jumpSession;
        markTopFetch();
        const t0 = Date.now();
        const el = g.document.documentElement;
        try { el.setAttribute('data-tps-fill-busy', String(t0)); } catch (_) { /* ignore */ }
        fillEvent('X asked for newer posts (near top: ' + (userNearTop() ? 'yes' : 'no') + ')');
        let out = null;
        try {
            out = await answerTopRequest(s, url, headerObj, decoded);
            return out;
        } catch (e) {
            fillEvent('answer error ' + (e && (e.message || e)) + ' → X loads it itself');
            throw e;
        } finally {
            markTopFetch();
            try { el.removeAttribute('data-tps-fill-busy'); } catch (_) { /* ignore */ }
            const ms = Date.now() - t0;
            fillEvent('answered in ' + (ms / 1000).toFixed(1) + ' s: ' + (s.lastAnswer || (out == null ? 'pass-through' : 'ok')));
            s.lastAnswer = '';
        }
    }

    async function answerTopRequest(s, url, headerObj, decoded) {
        // Use X's own Top request (40/page) for further steps.
        s.fetcher = { fetchAtB: makeFetchAtB(url, headerObj, decoded.A), pageSize: listPageSize(url, 40) };
        const K0 = decoded.B;
        let buf = s.buf;
        if (!buf || buf.base == null || K0 < buf.base || K0 > buf.K) {
            // X's Top cursor is not inside our buffer: restart from it.
            const floorB = (s.floor && s.floor.K === K0) ? s.floor.B : null;
            buf = s.buf = newFillBuffer(K0, floorB, false);
        } else if (K0 > buf.base) {
            while (buf.chunks.length && buf.chunks[0].K <= K0) buf.posts -= buf.chunks.shift().n;
            buf.base = K0;
        }
        if (!userNearTop()) {
            await sleepMs(NEAR_TOP_RECHECK_MS);
            if (!userNearTop()) {
                // Poll / prefetch while the user is not at the top: answer
                // "nothing new", keep X's Top cursor where it is (no gap).
                s.holds++;
                setFillState('hold');
                jumpLog('fill hold (not near top)');
                s.lastAnswer = 'held (not at the top)';
                prefetchFill(s);
                return holdResponseText();
            }
        }
        if (fillBusy) { s.lastAnswer = 'held (already answering one)'; return holdResponseText(); }
        fillBusy = true;
        try {
            buf.want = Math.max(buf.want, FILL_POSTS_PER_RESPONSE);
            pumpFill(s);
            const t0 = Date.now();
            // X asks again only after a minute: wait for a big chunk (or
            // "now"), but answer sooner rather than not at all.
            for (;;) {
                if (buf !== s.buf) break;
                if (buf.atNow || buf.dead || buf.posts >= FILL_POSTS_PER_RESPONSE) break;
                if (!s.pump) break;
                const waited = Date.now() - t0;
                if (waited >= FILL_RESPONSE_WAIT_MS && buf.posts > 0) break;
                if (waited >= FILL_RESPONSE_MAX_WAIT_MS) break;
                await sleepMs(100);
            }
            const drained = [];
            let added = 0;
            while (buf.chunks.length && added < FILL_POSTS_PER_RESPONSE) {
                const c = buf.chunks.shift();
                drained.push(c);
                added += c.n;
            }
            buf.posts -= added;
            const pages = [];
            for (let i = drained.length - 1; i >= 0; i--) pages.push.apply(pages, drained[i].pages);
            const atNow = buf.atNow && !buf.chunks.length;
            const built = buildTimelineResponse(s.skeleton, pages, K0, decoded.A, s.lastTopEntry, null);
            if (built.topEntry) s.lastTopEntry = built.topEntry;
            if (drained.length) buf.base = drained[drained.length - 1].K;
            if (built.newest != null && built.newest > buf.base) buf.base = built.newest;
            if (atNow) {
                s.fillDone = true;
                setFillState('now');
            } else if (buf.dead && !buf.chunks.length) {
                // Cannot find the next contiguous page: stop holding X's
                // requests so newer posts still arrive (may skip some).
                s.fillDone = true;
                setFillState('gave-up');
                jumpLog('fill gave up after', buf.fails, 'failed steps');
                s.lastAnswer = 'gave up after ' + buf.fails + ' failed steps (+' + built.tweetCount + ')';
                if (!built.tweetCount) return null;
            } else if (s.steps >= FILL_MAX_STEPS && !buf.chunks.length && !s.pump) {
                s.fillDone = true;
                setFillState('cap');
            } else {
                setFillState('step ' + s.steps);
                // Get the next chunk ready for X's next Top request.
                prefetchFill(s);
            }
            if (!built.tweetCount && !atNow) {
                // Nothing yet: keep X's cursor (retry on next Top request).
                jumpLog('fill: nothing buffered yet, hold', 'steps=', s.steps);
                s.lastAnswer = 'nothing ready yet (step ' + s.steps + ', fails ' + buf.fails + ')';
                return holdResponseText();
            }
            if (!built.topEntry && s.lastTopEntry) {
                const tl = timelineOf(built.json);
                tl.instructions[0].entries.push(s.lastTopEntry);
            }
            jumpLog('fill +' + built.tweetCount, 'steps=', s.steps, 'buffered=', buf.posts, atNow ? '(now)' : '');
            if (!s.lastAnswer) s.lastAnswer = '+' + built.tweetCount + ' posts' + (atNow ? ', reached now' : ', ' + buf.posts + ' more ready');
            const text = JSON.stringify(built.json);
            inspectResponseText(text);
            return text;
        } finally {
            fillBusy = false;
        }
    }

    function applySortMapFromPages(pages, order, merged, pageCount) {
        for (let p = 0; p < pages.length; p++) {
            const extracted = extractSortMapFromListJson(pages[p]);
            for (let i = 0; i < extracted.pairs.length; i++) {
                recordSortMapping(extracted.pairs[i][0], extracted.pairs[i][1]);
            }
        }
        lastJumpMeta = {
            order: order || [],
            jumpMerged: !!merged,
            pages: pageCount
        };
        publishSortMap();
    }

    function fakeXhrComplete(xhr, bodyText, responseURL) {
        const rt = xhr.responseType || '';
        let parsedJson = null;
        const getJson = () => {
            if (parsedJson == null) parsedJson = JSON.parse(bodyText);
            return parsedJson;
        };

        try {
            Object.defineProperty(xhr, 'readyState', { configurable: true, get: function () { return 4; } });
            Object.defineProperty(xhr, 'status', { configurable: true, get: function () { return 200; } });
            Object.defineProperty(xhr, 'statusText', { configurable: true, get: function () { return 'OK'; } });
            Object.defineProperty(xhr, 'responseURL', {
                configurable: true,
                get: function () { return responseURL || ''; }
            });
            Object.defineProperty(xhr, 'responseText', {
                configurable: true,
                get: function () {
                    if (rt === 'json') {
                        // Some engines still expose responseText for json.
                        return bodyText;
                    }
                    return bodyText;
                }
            });
            Object.defineProperty(xhr, 'response', {
                configurable: true,
                get: function () {
                    if (rt === 'json') {
                        try { return getJson(); } catch (_) { return null; }
                    }
                    if (rt === '' || rt === 'text') return bodyText;
                    return bodyText;
                }
            });
        } catch (e) {
            jumpLog('defineProperty on xhr failed', e && e.message);
        }

        xhr.getResponseHeader = function (name) {
            if (!name) return null;
            const n = String(name).toLowerCase();
            if (n === 'content-type') return 'application/json';
            return null;
        };
        xhr.getAllResponseHeaders = function () {
            return 'content-type: application/json\r\n';
        };

        const fire = function () {
            try {
                if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
            } catch (_) { /* ignore */ }
            try { xhr.dispatchEvent(new Event('readystatechange')); } catch (_) { /* ignore */ }
            try {
                if (typeof xhr.onload === 'function') xhr.onload();
            } catch (_) { /* ignore */ }
            try { xhr.dispatchEvent(new Event('load')); } catch (_) { /* ignore */ }
            try { xhr.dispatchEvent(new Event('loadend')); } catch (_) { /* ignore */ }
            try {
                if (typeof xhr.onloadend === 'function') xhr.onloadend();
            } catch (_) { /* ignore */ }
        };

        // Async, matching normal XHR completion timing.
        try {
            g.setTimeout(fire, 0);
        } catch (_) {
            try { fire(); } catch (__) { /* ignore */ }
        }
    }

    function setJumpResult(code) {
        try {
            g.document.documentElement.setAttribute('data-tps-jump-result', String(code || ''));
            jumpLog('result', code);
        } catch (_) { /* ignore */ }
    }

    function beginJumpHandling() {
        // Consume the one-shot arm immediately so the content script sees
        // data-tps-jump-used while chained pages are still in flight.
        try {
            const el = g.document.documentElement;
            el.removeAttribute('data-tps-jump');
            el.setAttribute('data-tps-jump-used', String(Date.now()));
            el.setAttribute('data-tps-jump-busy', '1');
            el.setAttribute('data-tps-jump-result', 'merge:busy');
        } catch (_) { /* ignore */ }
    }

    function endJumpBusy() {
        try { g.document.documentElement.removeAttribute('data-tps-jump-busy'); } catch (_) { /* ignore */ }
    }

    async function performJumpForUrl(headUrl, headerObj, jump) {
        const targetPos = jump.targetPos;
        const pageSize = listPageSize(headUrl, 20);
        beginJumpHandling();
        let why = 'no-target';

        if (targetPos) {
            try {
                // 1) Head page → density → merge-from-head only when close.
                const head = await fetchPageJson(headUrl, headerObj);
                if (!head.ok) {
                    why = 'status-' + head.status;
                } else {
                    const plan = planJumpStrategy(head.ids, targetPos, pageSize, jump.maxPosts);
                    jumpLog('plan', plan.mode, 'estPosts=', plan.estPosts, 'estPages=', plan.estPages,
                        'maxPages=', plan.maxPages);
                    if (plan.mode === 'merge') {
                        const collected = await collectMergedPages(headUrl, headerObj, targetPos,
                            plan.maxPages, head.json);
                        if (collected.reachedAt >= 0 && collected.pages.length) {
                            const merged = mergeTimelinePages(collected.pages);
                            if (merged && merged.json) {
                                startJumpSession({
                                    mode: 'merged', fillUp: false, A: jump.A,
                                    skeleton: skeletonFrom(head.json)
                                });
                                applySortMapFromPages(collected.pages, merged.order, true, collected.pages.length);
                                setJumpResult('merge:ok p=' + collected.pages.length + ' n=' + merged.tweetCount);
                                const mergedText = JSON.stringify(merged.json);
                                collected.pages.length = 0;
                                merged.json = null;
                                return { ok: true, merged: true, text: mergedText, url: headUrl };
                            }
                            why = 'synth';
                        } else {
                            why = collected.error || 'not-reached';
                        }
                    } else {
                        why = 'deep~' + plan.estPosts;
                    }
                    // 2) Bounded window around the target (never from the head).
                    const sfHint = estimateSfPerPost(head.ids);
                    head.json = null;
                    const win = await collectWindowPages(headUrl, headerObj, targetPos, jump.A,
                        jump.windowAbove == null ? DEFAULT_WINDOW_PAGES_ABOVE : jump.windowAbove, sfHint);
                    if (win.ok) {
                        const bottom = win.p0.extracted.bottomCursor;
                        const topTpl = win.p0.extracted.topCursor;
                        const skeleton = skeletonFrom(win.p0.json);
                        const built = buildTimelineResponse(skeleton, win.pages, null, jump.A, topTpl, bottom);
                        startJumpSession({
                            mode: 'window', fillUp: jump.fillUp, A: jump.A, sf: win.sf,
                            atNow: win.atNow, lastTopEntry: built.topEntry, skeleton,
                            floor: win.floorB != null ? { K: win.K, B: win.floorB } : null,
                            topK: built.newest != null ? built.newest : win.K,
                            fetcher: { fetchAtB: makeFetchAtB(headUrl, headerObj, jump.A), pageSize }
                        });
                        // v3.43: start loading the posts above in the
                        // background once X has rendered the window.
                        const sess = jumpSession;
                        g.setTimeout(() => prefetchFill(sess), FILL_PREFETCH_DELAY_MS);
                        applySortMapFromPages(win.pages, built.order, true, win.pages.length);
                        setJumpResult('window:ok p=' + win.pages.length + ' n=' + built.tweetCount +
                            ' (' + why + ')');
                        const text = JSON.stringify(built.json);
                        win.pages.length = 0;
                        return { ok: true, merged: true, text, url: headUrl };
                    }
                    why += '+window-' + win.error;
                }
            } catch (e) {
                jumpLog('jump error — fallback', e && (e.message || e));
                why = 'error';
            }
        }
        setJumpResult('merge:fallback(' + why + ')');

        // v3.28 fallback: single Bottom-cursor page near target (B/A from arm).
        try {
            const cursor = encodeListCursor(jump.A, jump.B, 2);
            const jumpUrl = urlWithCursor(headUrl, cursor);
            jumpLog('fallback single Bottom jump');
            const result = await fetchListPage(jumpUrl, headerObj);
            if (!result.ok) {
                jumpLog('fallback fetch failed', result.status);
                endJumpBusy();
                setJumpResult('merge:fallback(status-' + result.status + ')');
                return { ok: false, status: result.status };
            }
            let ex = null;
            let json = null;
            try {
                json = JSON.parse(result.text);
                ex = extractSortMapFromListJson(json);
            } catch (_) { /* ignore */ }
            startJumpSession({
                mode: 'single', fillUp: jump.fillUp, A: jump.A,
                sf: ex ? estimateSfPerPost(ex.positionIds) : null,
                lastTopEntry: ex ? ex.topCursor : null,
                skeleton: json ? skeletonFrom(json) : null
            });
            if (ex) applySortMapFromPages([json], ex.positionIds, false, 1);
            else inspectResponseText(result.text);
            return { ok: true, merged: false, text: result.text, url: result.url || jumpUrl };
        } catch (e) {
            jumpLog('fallback error', e && (e.message || e));
            endJumpBusy();
            setJumpResult('merge:fallback(error)');
            return { ok: false, error: e };
        }
    }

    const origFetch = g.fetch;
    if (typeof origFetch === 'function') {
        g.fetch = function (input, init) {
            let url = null;
            try {
                if (typeof input === 'string') url = input;
                else if (input && typeof input.url === 'string') url = input.url;
            } catch (_) { /* ignore */ }

            // Merged / fallback jump for cursorless list timeline.
            try {
                if (url && isListTimelineUrl(url) && isCursorlessListUrl(url)) {
                    const jump = readPendingJump();
                    if (jump) {
                        const headerObj = {};
                        try {
                            const h = init && init.headers;
                            if (h && typeof h.forEach === 'function') {
                                h.forEach((v, k) => { headerObj[k] = v; });
                            } else if (h && typeof h === 'object') {
                                Object.keys(h).forEach((k) => { headerObj[k] = h[k]; });
                            }
                        } catch (_) { /* ignore */ }
                        return performJumpForUrl(url, headerObj, jump).then((result) => {
                            if (!result || !result.ok) {
                                // Last resort: let the original cursorless request through.
                                jumpLog('jump failed entirely — passthrough');
                                return origFetch.call(this, input, init);
                            }
                            return new Response(result.text, {
                                status: 200,
                                statusText: 'OK',
                                headers: { 'content-type': 'application/json' }
                            });
                        }).catch((e) => {
                            jumpLog('fetch jump path error', e && (e.message || e));
                            return origFetch.call(this, input, init);
                        });
                    }
                }
            } catch (_) { /* fall through */ }

            // v3.42 fill-up: answer Top requests (newer posts) ourselves while a
            // jump session is filling; the request URL is never rewritten.
            try {
                if (url && isListTimelineUrl(url) && sessionWantsFill() && topCursorOfUrl(url)) {
                    const headerObj = {};
                    try {
                        const h = init && init.headers;
                        if (h && typeof h.forEach === 'function') {
                            h.forEach((v, k) => { headerObj[k] = v; });
                        } else if (h && typeof h === 'object') {
                            Object.keys(h).forEach((k) => { headerObj[k] = h[k]; });
                        }
                    } catch (_) { /* ignore */ }
                    const self = this;
                    return handleTopRequest(url, headerObj).then((text) => {
                        if (text == null) return passthroughFetch(self, input, init, url);
                        return new Response(text, {
                            status: 200,
                            statusText: 'OK',
                            headers: { 'content-type': 'application/json' }
                        });
                    }).catch((e) => {
                        jumpLog('fill path error', e && (e.message || e));
                        return passthroughFetch(self, input, init, url);
                    });
                }
            } catch (_) { /* fall through */ }

            return passthroughFetch(this, input, init, url);
        };
    }

    function passthroughFetch(self, input, init, url) {
            const result = origFetch.call(self, input, init);
            if (isListTimelineUrl(url)) {
                try {
                    return Promise.resolve(result).then((res) => {
                        try {
                            const clone = res.clone();
                            clone.text().then(inspectResponseText).catch(() => {});
                        } catch (_) { /* ignore */ }
                        return res;
                    });
                } catch (_) { /* fall through */ }
            }
            return result;
    }

    const XHR = g.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        const origSetRequestHeader = XHR.prototype.setRequestHeader;

        XHR.prototype.open = function (method, url) {
            try {
                this.__tpsListUrl = typeof url === 'string' ? url : null;
                this.__tpsMethod = method;
                this.__tpsHeaders = [];
                this.__tpsJumpHandled = false;
            } catch (_) { /* ignore */ }
            return origOpen.apply(this, arguments);
        };

        XHR.prototype.setRequestHeader = function (name, value) {
            try {
                if (!this.__tpsHeaders) this.__tpsHeaders = [];
                this.__tpsHeaders.push([name, value]);
            } catch (_) { /* ignore */ }
            return origSetRequestHeader.apply(this, arguments);
        };

        XHR.prototype.send = function () {
            const xhr = this;
            const args = arguments;
            try {
                if (isListTimelineUrl(xhr.__tpsListUrl) && isCursorlessListUrl(xhr.__tpsListUrl)) {
                    const jump = readPendingJump();
                    if (jump) {
                        xhr.__tpsJumpHandled = true;
                        const headerObj = headersToObject(xhr.__tpsHeaders);
                        const headUrl = xhr.__tpsListUrl;
                        performJumpForUrl(headUrl, headerObj, jump).then((result) => {
                            if (result && result.ok) {
                                fakeXhrComplete(xhr, result.text, result.url || headUrl);
                                return;
                            }
                            // Fall through: send original cursorless request.
                            jumpLog('XHR jump failed — origSend passthrough');
                            try {
                                if (isListTimelineUrl(xhr.__tpsListUrl)) {
                                    const onLoad = function () {
                                        try { xhr.removeEventListener('load', onLoad); } catch (_) { /* ignore */ }
                                        try { inspectResponseText(xhr.responseText); } catch (_) { /* ignore */ }
                                    };
                                    xhr.addEventListener('load', onLoad);
                                }
                            } catch (_) { /* ignore */ }
                            return origSend.apply(xhr, args);
                        }).catch((e) => {
                            jumpLog('XHR jump path error', e && (e.message || e));
                            try { return origSend.apply(xhr, args); } catch (_) { /* ignore */ }
                        });
                        return;
                    }
                }
            } catch (e) {
                jumpLog('XHR send jump detect error', e && (e.message || e));
            }

            // v3.42 fill-up (see fetch patch).
            try {
                if (isListTimelineUrl(xhr.__tpsListUrl) && sessionWantsFill() && topCursorOfUrl(xhr.__tpsListUrl)) {
                    const headerObj = headersToObject(xhr.__tpsHeaders);
                    const topUrl = xhr.__tpsListUrl;
                    const sendOrig = function () {
                        try {
                            const onLoad = function () {
                                try { xhr.removeEventListener('load', onLoad); } catch (_) { /* ignore */ }
                                try { inspectResponseText(xhr.responseText); } catch (_) { /* ignore */ }
                            };
                            xhr.addEventListener('load', onLoad);
                        } catch (_) { /* ignore */ }
                        return origSend.apply(xhr, args);
                    };
                    handleTopRequest(topUrl, headerObj).then((text) => {
                        if (text == null) return sendOrig();
                        fakeXhrComplete(xhr, text, topUrl);
                    }).catch((e) => {
                        jumpLog('XHR fill path error', e && (e.message || e));
                        try { sendOrig(); } catch (_) { /* ignore */ }
                    });
                    return;
                }
            } catch (e) {
                jumpLog('XHR fill detect error', e && (e.message || e));
            }

            try {
                if (isListTimelineUrl(this.__tpsListUrl)) {
                    const onLoad = function () {
                        try { xhr.removeEventListener('load', onLoad); } catch (_) { /* ignore */ }
                        try { inspectResponseText(xhr.responseText); } catch (_) { /* ignore */ }
                    };
                    this.addEventListener('load', onLoad);
                }
            } catch (_) { /* ignore */ }
            return origSend.apply(this, arguments);
        };
    }

    g.__tpsPlanJumpStrategy = planJumpStrategy;
    g.__tpsMergePageBudget = mergePageBudget;
    g.__tpsEstimateSfPerPost = estimateSfPerPost;
    g.__tpsClassifyStep = classifyStep;
    g.__tpsStepAbove = stepAbove;
    g.__tpsNextStepCursorB = nextStepCursorB;
    g.__tpsBuildTimelineResponse = buildTimelineResponse;
    g.__tpsJumpSession = function () { return jumpSession; };
    g.__tpsDecodeListCursor = decodeListCursor;
    g.__tpsEncodeListCursor = encodeListCursor;
    g.__tpsExtractSortMapFromListJson = extractSortMapFromListJson;
    g.__tpsMergeTimelinePages = mergeTimelinePages;
    g.__tpsPagePassesTarget = pagePassesTarget;
    g.__tpsMergeStopDecision = mergeStopDecision;
    g.__tpsFakeXhrComplete = fakeXhrComplete;
}
/* TPS_JUMP_HOOK_END */


// Gear / extension (isolated world): bounded page-realm injection.
// Primary path on Chrome/Firefox is a separate MAIN-world content script
// (page-hook.js). Fallbacks here: extension WAR <script src> once, then
// nonce-inline once. Never blob:, never unbounded MutationObserver loops.
function tpsPageHookRealmsRe() {
    return /\|(main|war|injected|tm)$/;
}

function tpsPageHookPresent(doc) {
    try {
        const d = doc || document;
        const v = d.documentElement.getAttribute('data-tps-hook') || '';
        return tpsPageHookRealmsRe().test(v);
    } catch (_) {
        return false;
    }
}

function tpsFindCspNonce(doc) {
    const d = doc || document;
    try {
        const scripts = d.querySelectorAll('script[nonce]');
        for (let i = 0; i < scripts.length; i++) {
            let n = null;
            try { n = scripts[i].nonce; } catch (_) { /* ignore */ }
            if (!n) {
                try { n = scripts[i].getAttribute('nonce'); } catch (_) { /* ignore */ }
            }
            if (n) return n;
        }
    } catch (_) { /* ignore */ }
    try {
        const all = d.querySelectorAll('[nonce]');
        for (let i = 0; i < all.length; i++) {
            let n = null;
            try { n = all[i].nonce; } catch (_) { /* ignore */ }
            if (!n) {
                try { n = all[i].getAttribute('nonce'); } catch (_) { /* ignore */ }
            }
            if (n) return n;
        }
    } catch (_) { /* ignore */ }
    return null;
}

function tpsGetExtensionPageHookUrl() {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
            return chrome.runtime.getURL('page-hook.js');
        }
    } catch (_) { /* ignore */ }
    try {
        if (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.getURL === 'function') {
            return browser.runtime.getURL('page-hook.js');
        }
    } catch (_) { /* ignore */ }
    return null;
}

// Pure-ish orchestrator for tests: each method at most once; observer cannot loop.
// opts: { document, getWarUrl, buildInlineCode, findNonce, pageHookPresent, markAttemptedAttr }
function tpsRunBoundedPageInject(opts) {
    const doc = opts.document;
    if (!doc || !doc.documentElement) {
        return { appended: 0, attempted: {}, present: false, _test: { getObserverTicks: function () { return 0; }, isFinished: function () { return true; } } };
    }
    const attemptedAttr = opts.markAttemptedAttr || 'data-tps-inject-attempted';
    if (doc.documentElement.getAttribute(attemptedAttr) === '1') {
        return {
            appended: 0,
            attempted: { already: true },
            present: !!(opts.pageHookPresent && opts.pageHookPresent(doc)),
            _test: { getObserverTicks: function () { return 0; }, isFinished: function () { return true; } }
        };
    }
    try { doc.documentElement.setAttribute(attemptedAttr, '1'); } catch (_) { /* ignore */ }

    const attempted = { war: false, nonceInline: false };
    const stats = {
        appended: 0,
        attempted: attempted,
        present: false,
        disconnect: null,
        _test: null
    };
    let finished = false;
    let mo = null;
    let observerTicks = 0;
    const MAX_OBSERVER_TICKS = 8;

    function present() {
        try { return !!(opts.pageHookPresent && opts.pageHookPresent(doc)); }
        catch (_) { return false; }
    }

    function done() {
        finished = true;
        if (mo) {
            try { mo.disconnect(); } catch (_) { /* ignore */ }
            mo = null;
        }
    }

    function isOurInjectNode(node) {
        try {
            return !!(node && node.nodeType === 1 && node.getAttribute &&
                node.getAttribute('data-tps-inject'));
        } catch (_) {
            return false;
        }
    }

    function mutationsAreOnlyOurs(mutations) {
        if (!mutations || !mutations.length) return false;
        for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'attributes') {
                if (!isOurInjectNode(m.target) && m.attributeName !== attemptedAttr &&
                    m.attributeName !== 'data-tps-page-injected') {
                    return false;
                }
                continue;
            }
            const lists = [m.addedNodes, m.removedNodes];
            for (let li = 0; li < lists.length; li++) {
                const list = lists[li];
                if (!list) continue;
                for (let j = 0; j < list.length; j++) {
                    if (!isOurInjectNode(list[j])) return false;
                }
            }
        }
        return true;
    }

    function injectWar() {
        if (attempted.war || finished || present()) return present();
        attempted.war = true;
        let url = null;
        try { url = opts.getWarUrl && opts.getWarUrl(); } catch (_) { url = null; }
        if (!url) return false;
        try {
            const s = doc.createElement('script');
            s.src = url;
            s.async = false;
            s.setAttribute('data-tps-inject', 'war');
            const parent = doc.documentElement || doc.head || doc.body;
            if (!parent) return false;
            parent.appendChild(s);
            stats.appended++;
            // Leave in DOM until load/error so the browser can fetch it.
            const cleanup = function () {
                try { s.remove(); } catch (_) { /* ignore */ }
                if (present()) done();
            };
            try { s.addEventListener('load', cleanup); } catch (_) { /* ignore */ }
            try { s.addEventListener('error', cleanup); } catch (_) { /* ignore */ }
            return true;
        } catch (_) {
            return false;
        }
    }

    function injectNonceInline() {
        if (attempted.nonceInline || finished || present()) return present();
        let nonce = null;
        try { nonce = opts.findNonce ? opts.findNonce(doc) : null; } catch (_) { nonce = null; }
        if (!nonce) return false;
        attempted.nonceInline = true;
        let code = '';
        try { code = opts.buildInlineCode ? opts.buildInlineCode() : ''; } catch (_) { code = ''; }
        if (!code) return false;
        try {
            const s = doc.createElement('script');
            try { s.nonce = nonce; } catch (_) { /* ignore */ }
            try { s.setAttribute('nonce', nonce); } catch (_) { /* ignore */ }
            s.setAttribute('data-tps-inject', 'nonce');
            s.textContent = code;
            const parent = doc.documentElement || doc.head || doc.body;
            if (!parent) return false;
            parent.appendChild(s);
            stats.appended++;
            try { s.remove(); } catch (_) { /* ignore */ }
            try { doc.documentElement.setAttribute('data-tps-page-injected', '1'); } catch (_) { /* ignore */ }
            return present();
        } catch (_) {
            return false;
        }
    }

    if (present()) {
        done();
        stats.present = true;
        stats.disconnect = done;
        stats._test = {
            getObserverTicks: function () { return observerTicks; },
            isFinished: function () { return finished; }
        };
        return stats;
    }

    injectWar();
    if (present()) {
        done();
        stats.present = true;
        stats.disconnect = done;
        stats._test = {
            getObserverTicks: function () { return observerTicks; },
            isFinished: function () { return finished; }
        };
        return stats;
    }

    injectNonceInline();
    if (present() || (attempted.war && attempted.nonceInline)) {
        // If nonce was available we tried it; if not, watch briefly for a nonce.
        if (present() || attempted.nonceInline) {
            done();
            stats.present = present();
            stats.disconnect = done;
            stats._test = {
                getObserverTicks: function () { return observerTicks; },
                isFinished: function () { return finished; }
            };
            return stats;
        }
    }

    // Observer: only to catch a late nonce. Never re-tries WAR. Ignores our nodes.
    try {
        const root = doc.documentElement || doc;
        mo = new (opts.MutationObserver || MutationObserver)(function (mutations) {
            if (finished) return;
            observerTicks++;
            if (present()) { done(); return; }
            if (mutationsAreOnlyOurs(mutations)) {
                if (observerTicks >= MAX_OBSERVER_TICKS) done();
                return;
            }
            if (!attempted.nonceInline) {
                injectNonceInline();
            }
            if (present() || attempted.nonceInline || observerTicks >= MAX_OBSERVER_TICKS) {
                done();
            }
        });
        mo.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['nonce']
        });
    } catch (_) {
        done();
    }

    stats.present = present();
    stats.disconnect = done;
    stats._test = {
        getObserverTicks: function () { return observerTicks; },
        isFinished: function () { return finished; }
    };
    return stats;
}

function tpsInjectPageRealmScripts() {
    'use strict';
    if (typeof document === 'undefined') return;

    const ver = typeof TPS_VERSION !== 'undefined' ? TPS_VERSION : '0';

    function buildInlineCode() {
        return [
            '(' + tpsInstallPageScrollGuard.toString() + ')(window);',
            '(' + tpsInstallPageJumpHook.toString() + ')(window,"injected",' + JSON.stringify(ver) + ');'
        ].join('\n');
    }

    tpsRunBoundedPageInject({
        document: document,
        getWarUrl: tpsGetExtensionPageHookUrl,
        buildInlineCode: buildInlineCode,
        findNonce: tpsFindCspNonce,
        pageHookPresent: tpsPageHookPresent,
        MutationObserver: typeof MutationObserver !== 'undefined' ? MutationObserver : null
    });
}



(function() {
    'use strict';

    try {
        if (typeof unsafeWindow !== 'undefined') {
            tpsInstallPageScrollGuard(unsafeWindow);
            tpsInstallPageJumpHook(unsafeWindow, 'tm', TPS_VERSION);
        } else {
            // Extension isolated world: bounded WAR / nonce fallbacks (MAIN world
            // page-hook.js is the primary path via manifest).
            tpsInjectPageRealmScripts();
        }
    } catch (_) { /* ignore */ }
    try {
        // Best-effort local install. Skips if a page-realm hook is already marked.
        tpsInstallPageScrollGuard(window);
        tpsInstallPageJumpHook(window, 'local', TPS_VERSION);
    } catch (_) { /* ignore */ }

    const CONFIG = {
        targetTab: 'Olo',         // auto-scroll only works on this timeline tab
        saveIntervalMs: 2000,     // how often the current position is stored
        stepMaxWaitMs: 8000,      // hard cap waiting for one scroll step to load
        maxScrollAttempts: 150,   // give up searching after this many scroll steps
        // Soft "end" = bottom of *loaded* content while X may still fetch more.
        bottomConfirmMs: 2500,
        endConfirmAttempts: 5,
        endRetryDelayMs: 400,
        stuckConfirmAttempts: 5,
        // Small steps. A big jump skips virtualized tweets and, on iOS, grows the
        // page until the tab is killed and X reloads — which starts the search over.
        // In the 2026-10-05 measurement X stayed at <=11 mounted tweets while
        // scrolling ~5 screens/s, so 0.9 screen every 250ms (~3.6 screens/s) is
        // safe. A step under one screen still passes every tweet through view.
        minStepGapMs: 250,
        stepViewportRatio: 0.9,
        // Hard cap on tweets X may keep mounted during a search. The script
        // cannot set a browser memory quota; it stops scrolling until the count
        // drops, so the tab is not killed and reloaded.
        // Measured 2026-10-05 on the Olo timeline: at 390x844 X kept at most 14
        // articles (median 11) at reading pace and at most 11 when scrolling
        // fast; desktop width peaked at 10. 20 leaves room for taller phones
        // and tall media posts while still catching a DOM that keeps growing.
        // Raised to 100 on request: only a runaway DOM should stop the search.
        maxMountedTweets: 100,
        autoRestore: true,        // jump back automatically when the timeline loads
        // Cursor jump: rewrite the first ListLatestTweetsTimeline request so the
        // Olo list opens near the saved tweet instead of scrolling from the top.
        cursorJump: true,
        jumpLeadMs: 60 * 60 * 1000, // fallback single-jump: ~1h of newer tweets above the pin
        jumpAnchor: 'now',         // 'now' = snowflakeFromMs(Date.now()); 'b' = use B
        // Fill-up: after a window/fallback jump, answer X's "newer posts" request
        // (scroll to top) with contiguous pages above the jump; stops at "now".
        jumpFillUp: true,
        // Merged jump: chain head→Bottom pages until saved pos (+1 page), deliver one response.
        jumpMerge: true,
        // v3.42: merge from the head only when the target is within this many
        // POSTS of the newest one (X serves 20 posts/page → 6 pages, 40/page →
        // 3 pages). Deeper targets get a bounded window instead: the page at the
        // target plus jumpWindowPagesAbove contiguous pages above it.
        jumpMergeMaxPosts: 120,
        jumpWindowPagesAbove: 2,
    };

    const DEBUG = false;

    function allowProgrammaticScroll(ms) {
        const until = Date.now() + (ms == null ? 4000 : ms);
        try {
            const g = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
            g.__tpsAllowScrollUntil = until;
            g.postMessage({ source: 'tps', type: 'allow-scroll', until }, '*');
        } catch (_) { /* ignore */ }
        try {
            document.documentElement.setAttribute('data-tps-allow-scroll', String(until));
        } catch (_) { /* ignore */ }
    }

    // ---- Scroll debug / write helpers (tps_debug_scroll=1 or #tpsdebug) ----
    // Persist hash toggles so Gear reloads keep the overlay.
    try {
        const h0 = String(location.hash || '');
        if (/(?:^|[&#])tpsdebugoff(?:&|$)/.test(h0)) {
            localStorage.setItem('tps_debug_scroll', '0');
        } else if (/(?:^|[&#])tpsdebug(?:&|$)/.test(h0)) {
            localStorage.setItem('tps_debug_scroll', '1');
        }
        if (/(?:^|[&#])tpsnoanchor(?:&|$)/.test(h0)) {
            localStorage.setItem('tps_debug_noanchor', '1');
        }
    } catch (_) { /* ignore */ }

    function tpsDebugFlag(name) {
        try {
            if (localStorage.getItem(name) === '1') return true;
        } catch (_) { /* ignore */ }
        try {
            const h = String(location.hash || '');
            if (name === 'tps_debug_scroll' && /(?:^|[&#])tpsdebug(?:&|$)/.test(h) &&
                !/(?:^|[&#])tpsdebugoff(?:&|$)/.test(h)) return true;
            if (name === 'tps_debug_noanchor' && /(?:^|[&#])tpsnoanchor(?:&|$)/.test(h)) return true;
        } catch (_) { /* ignore */ }
        return false;
    }

    const TPS_DEBUG_SCROLL = tpsDebugFlag('tps_debug_scroll');
    const TPS_DEBUG_NOANCHOR = tpsDebugFlag('tps_debug_noanchor');
    let tpsLastScrollWriter = 'none';
    let tpsOurScrollUntil = 0;

    function scrollLog() {
        if (!TPS_DEBUG_SCROLL) return;
        try {
            const args = Array.prototype.slice.call(arguments);
            args.unshift('[TPS scroll]');
            console.log.apply(console, args);
        } catch (_) { /* ignore */ }
    }

    function markOurScroll(reason, ms) {
        tpsLastScrollWriter = String(reason || 'unknown');
        const hold = ms == null ? 80 : ms;
        tpsOurScrollUntil = Date.now() + hold;
        try {
            document.documentElement.setAttribute('data-tps-our-scroll', tpsLastScrollWriter);
            document.documentElement.setAttribute('data-tps-our-scroll-until', String(tpsOurScrollUntil));
        } catch (_) { /* ignore */ }
        scrollLog('write', tpsLastScrollWriter);
    }

    // All TPS programmatic scroll writes should go through here.
    function tpsScrollWrite(reason, fn) {
        markOurScroll(reason, 120);
        allowProgrammaticScroll(Math.max(400, (reason && reason.indexOf('land') >= 0) ? 800 : 600));
        try { return fn(); } catch (e) {
            scrollLog('write-error', reason, e && e.message);
            return undefined;
        }
    }

    // Pure: true when a scroll delta looks like X teleporting to the top, not a
    // user scrolling up through the feed (or a small layout shift).
    function isLikelyXYank(prevY, nextY, viewportH) {
        const vh = viewportH > 0 ? viewportH : 800;
        const topBand = Math.min(140, vh * 0.2);
        const minPrev = vh * 1.5;
        const minDelta = 250;
        if (!(nextY < topBand)) return false;
        if (!(prevY > minPrev)) return false;
        if (!(prevY - nextY >= minDelta)) return false;
        return true;
    }

    function applyDebugNoAnchorCss() {
        if (!TPS_DEBUG_NOANCHOR) return;
        try {
            if (!document.getElementById('tps-debug-noanchor')) {
                const s = document.createElement('style');
                s.id = 'tps-debug-noanchor';
                s.textContent = [
                    'html, body, html body, #react-root, #react-root > div,',
                    '[data-testid="primaryColumn"], [data-testid="primaryColumn"] *,',
                    '[data-testid="cellInnerDiv"], [data-testid="cellInnerDiv"] *',
                    '{ overflow-anchor: none !important; }'
                ].join(' ');
                (document.documentElement || document.head).appendChild(s);
                scrollLog('noanchor css injected (Chrome≈iOS)');
            }
            try {
                const se = document.scrollingElement || document.documentElement;
                const oa = function (el) {
                    try {
                        return getComputedStyle(el).getPropertyValue('overflow-anchor').trim();
                    } catch (_) { return '?'; }
                };
                scrollLog('noanchor verify',
                    'se=' + oa(se),
                    'html=' + oa(document.documentElement),
                    'body=' + (document.body ? oa(document.body) : 'n/a'));
            } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }
    }


    const STORAGE_PREFIX = 'tps_';

    function gmGet(key) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key);
        }
        try {
            const value = localStorage.getItem(STORAGE_PREFIX + key);
            return value === null ? undefined : JSON.parse(value);
        } catch {
            return undefined;
        }
    }

    function gmSet(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(key, value);
            return;
        }
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }

    const KEY_TWEET_ID = 'tweet_id';
    const KEY_TWEET_TIME = 'tweet_time';
    const KEY_SORT_ID = 'sort_pos'; // 3.26 stored sortIndex under 'sort_id'; ignore it
    const KEY_TIMESTAMP = 'timestamp';
    const KEY_PATH = 'path';
    const KEY_RESTORE_ACTIVE = 'restore_active';
    const KEY_RESTORE_CRASHES = 'restore_crashes';
    // v3.42: saved tweet id whose restore reloaded the tab once; never auto-jump
    // to it again (cleared as soon as a different position is saved).
    const KEY_JUMP_BLOCKED = 'jump_blocked_id';

    // ============ LIST CURSOR / SNOWFLAKE HELPERS ============

    const TWITTER_EPOCH_MS = 1288834974657n;

    function snowflakeFromMs(ms) {
        return (BigInt(ms) - TWITTER_EPOCH_MS) << 22n;
    }

    function msFromSnowflake(id) {
        return Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
    }

    function writeU64BE(view, offset, value) {
        const v = BigInt(value);
        view.setUint32(offset, Number((v >> 32n) & 0xffffffffn));
        view.setUint32(offset + 4, Number(v & 0xffffffffn));
    }

    function readU64BE(view, offset) {
        const hi = BigInt(view.getUint32(offset));
        const lo = BigInt(view.getUint32(offset + 4));
        return (hi << 32n) | lo;
    }

    function bytesToB64Url(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        const b64 = btoa(s);
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function b64UrlToBytes(str) {
        const pad = '='.repeat((4 - (str.length % 4)) % 4);
        const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function encodeListCursor(aBig, bBig, type) {
        const buf = new Uint8Array(34);
        const view = new DataView(buf.buffer);
        let i = 0;
        buf[i++] = 0x0c;
        view.setUint16(i, 1); i += 2;
        buf[i++] = 0x0a;
        view.setUint16(i, 1); i += 2;
        writeU64BE(view, i, aBig); i += 8;
        buf[i++] = 0x0a;
        view.setUint16(i, 2); i += 2;
        writeU64BE(view, i, bBig); i += 8;
        buf[i++] = 0x08;
        view.setUint16(i, 3); i += 2;
        view.setInt32(i, Number(type)); i += 4;
        buf[i++] = 0x00;
        buf[i++] = 0x00;
        return bytesToB64Url(buf);
    }

    function decodeListCursor(str) {
        const buf = b64UrlToBytes(str);
        if (buf.length < 34) throw new Error('cursor too short');
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let i = 0;
        if (buf[i++] !== 0x0c) throw new Error('bad struct');
        if (view.getUint16(i) !== 1) throw new Error('bad outer field');
        i += 2;
        if (buf[i++] !== 0x0a) throw new Error('bad A type');
        if (view.getUint16(i) !== 1) throw new Error('bad A field');
        i += 2;
        const A = readU64BE(view, i); i += 8;
        if (buf[i++] !== 0x0a) throw new Error('bad B type');
        if (view.getUint16(i) !== 2) throw new Error('bad B field');
        i += 2;
        const B = readU64BE(view, i); i += 8;
        if (buf[i++] !== 0x08) throw new Error('bad type type');
        if (view.getUint16(i) !== 3) throw new Error('bad type field');
        i += 2;
        const type = view.getInt32(i);
        return { A, B, type };
    }

    function isHomeTimelinePath(p) {
        return p === '/home' || p === '/';
    }

    function jumpWasUsed() {
        try {
            return !!document.documentElement.getAttribute('data-tps-jump-used');
        } catch (_) {
            return false;
        }
    }

    function clearJumpUsed() {
        try { document.documentElement.removeAttribute('data-tps-jump-used'); } catch (_) { /* ignore */ }
        try { document.documentElement.removeAttribute('data-tps-jump-merged'); } catch (_) { /* ignore */ }
        try { document.documentElement.removeAttribute('data-tps-jump-busy'); } catch (_) { /* ignore */ }
        try { document.documentElement.removeAttribute('data-tps-jump-result'); } catch (_) { /* ignore */ }
        try { document.documentElement.removeAttribute('data-tps-jump-mode'); } catch (_) { /* ignore */ }
        try { document.documentElement.removeAttribute('data-tps-fill'); } catch (_) { /* ignore */ }
    }

    function jumpIsBusy() {
        try {
            return document.documentElement.getAttribute('data-tps-jump-busy') === '1';
        } catch (_) {
            return false;
        }
    }

    async function waitForJumpIdle(ctrl, maxWaitMs) {
        const start = Date.now();
        const limit = maxWaitMs == null ? 60000 : maxWaitMs;
        while (Date.now() - start < limit) {
            if (ctrl && ctrl.aborted) return false;
            if (!jumpIsBusy()) return true;
            await sleep(100);
        }
        return !jumpIsBusy();
    }

    function jumpWasMerged() {
        try {
            if (document.documentElement.getAttribute('data-tps-jump-merged') === '1') return true;
            if (document.documentElement.getAttribute('data-tps-jump-session') === 'merged') return true;
            const meta = readJumpSortMeta();
            return !!(meta && meta.jumpMerged && Array.isArray(meta.order) && meta.order.length);
        } catch (_) {
            return false;
        }
    }

    // Always-on console for jump/positioning (DEBUG may be false).
    function jumpLog(...args) {
        try { console.log('[Timeline Saver]', ...args); } catch (_) { /* ignore */ }
        try { log(...args); } catch (_) { /* ignore */ }
    }

    // Arm: B|A|expires|fillUp|targetPos|maxPosts|windowAbove on <html data-tps-jump>.
    // B/A used for v3.28 single-jump fallback; targetPos drives the merged path.
    function armCursorJump(saved, expiresMs) {
        if (!CONFIG.cursorJump || !saved || !saved.tweetId) return false;
        const path = saved.path || currentPath();
        if (!isHomeTimelinePath(path)) return false;
        try {
            const sortId = BigInt(String(saved.sortId || saved.tweetId));
            const leadMs = BigInt(CONFIG.jumpLeadMs == null ? 60 * 60 * 1000 : CONFIG.jumpLeadMs);
            const B = sortId + (leadMs << 22n);
            let A;
            if (CONFIG.jumpAnchor === 'b') {
                A = B;
            } else {
                A = snowflakeFromMs(Date.now());
            }
            const expires = Date.now() + (expiresMs == null ? 20000 : expiresMs);
            clearJumpUsed();
            try { document.documentElement.removeAttribute('data-tps-jump-session'); } catch (_) { /* ignore */ }
            const fillUp = CONFIG.jumpFillUp === false ? '0' : '1';
            const maxPosts = CONFIG.jumpMergeMaxPosts == null ? 120 : CONFIG.jumpMergeMaxPosts;
            const above = CONFIG.jumpWindowPagesAbove == null ? 2 : CONFIG.jumpWindowPagesAbove;
            const preferMerge = CONFIG.jumpMerge !== false;
            const payload = preferMerge
                ? (B.toString(10) + '|' + A.toString(10) + '|' + String(expires) + '|' + fillUp +
                    '|' + sortId.toString(10) + '|' + String(maxPosts) + '|' + String(above))
                : (B.toString(10) + '|' + A.toString(10) + '|' + String(expires) + '|' + fillUp);
            document.documentElement.setAttribute('data-tps-jump', payload);
            jumpLog('Armed cursor jump target=', sortId.toString(), 'B=', B.toString(),
                'merge=', preferMerge, 'maxPosts=', maxPosts, 'above=', above);
            return true;
        } catch (e) {
            jumpLog('armCursorJump failed', e);
            return false;
        }
    }

    async function waitForJumpUsed(ctrl, maxWaitMs) {
        const start = Date.now();
        const limit = maxWaitMs == null ? 3000 : maxWaitMs;
        while (Date.now() - start < limit) {
            if (ctrl && ctrl.aborted) return false;
            if (jumpWasUsed()) return true;
            await sleep(40);
        }
        return jumpWasUsed();
    }

    // One-shot: leave Olo, re-arm, come back so ListLatestTweetsTimeline fires again.
    async function refetchTargetTabWithJump(saved, ctrl) {
        const tabs = getNavigationTabs();
        const other = tabs.find(t => {
            const label = getTabLabel(t);
            return label && label !== CONFIG.targetTab;
        });
        if (!other) return false;
        try {
            other.click();
        } catch (_) {
            return false;
        }
        await sleep(350);
        if (ctrl.aborted) return false;
        armCursorJump(saved, 15000);
        return ensureTargetTab(ctrl, 6000);
    }

    let gentleRestore = false;
    let lastScrollStepAt = 0;

    const PANEL_ID = 'timeline-saver-panel';
    const PANEL_INFO_ID = 'timeline-saver-info';
    const BUTTON_ID = 'timeline-saver-day-button';

    function log(...args) {
        if (DEBUG) console.log('[Timeline Saver]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============ PAGE HELPERS ============

    function currentPath() {
        return location.pathname;
    }

    function isTimelinePath(p) {
        return p === '/' ||
            p === '/home' ||
            p === '/i/bookmarks' ||
            p.startsWith('/search') ||
            /^\/i\/lists\/\d+$/.test(p) ||
            /^\/[^/]+$/.test(p) ||
            /^\/[^/]+\/(with_replies|media|likes|highlights)$/.test(p);
    }

    function isTimelinePage() {
        return isTimelinePath(currentPath());
    }

    function extractTweetId(article) {
        const link = article.querySelector('a[href*="/status/"]');
        const match = link && link.href.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    }

    function getTweetTime(article) {
        const time = article.querySelector('time[datetime]');
        return time ? time.getAttribute('datetime') : null;
    }

    function readSortMap() {
        try {
            const el = document.getElementById('tps-sortmap');
            if (!el || !el.textContent) return {};
            const obj = JSON.parse(el.textContent);
            return obj && typeof obj === 'object' ? obj : {};
        } catch (_) {
            return {};
        }
    }

    function readJumpSortMeta() {
        const obj = readSortMap();
        const order = Array.isArray(obj.order) ? obj.order.map(String) : null;
        return {
            order,
            jumpMerged: obj.jumpMerged === true,
            pages: obj.pages != null ? Number(obj.pages) : null
        };
    }

    async function waitForJumpOrder(ctrl, maxWaitMs) {
        const start = Date.now();
        const limit = maxWaitMs == null ? 8000 : maxWaitMs;
        while (Date.now() - start < limit) {
            if (ctrl && ctrl.aborted) return null;
            const meta = readJumpSortMeta();
            if (meta.order && meta.order.length) return meta;
            await sleep(50);
        }
        return readJumpSortMeta().order ? readJumpSortMeta() : null;
    }

    function lookupSortId(tweetId) {
        if (!tweetId) return null;
        const mapped = readSortMap()[String(tweetId)];
        // Skip metadata keys accidentally looked up.
        if (mapped == null || typeof mapped === 'object' || Array.isArray(mapped)) return null;
        if (mapped === true || mapped === false) return null;
        return String(mapped);
    }

    function isRepostArticle(article) {
        try {
            const ctx = article.querySelector('[data-testid="socialContext"]');
            if (!ctx) return false;
            const t = (ctx.textContent || '').toLowerCase();
            return /repost|reposted|retweet|retweeted|podał dalej|reenvi|reposté|hat retweetet/.test(t);
        } catch (_) {
            return false;
        }
    }

    // Timeline order id for jumping/saving. Prefer GraphQL sortIndex; for reposts
    // without a map entry, use the nearest non-repost article above in the DOM.
    function resolveSortIdForArticle(article, tweetId) {
        const mapped = lookupSortId(tweetId);
        if (mapped) return mapped;
        if (article && isRepostArticle(article)) {
            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            const idx = articles.indexOf(article);
            for (let i = idx - 1; i >= 0; i--) {
                if (isRepostArticle(articles[i])) continue;
                const aboveId = extractTweetId(articles[i]);
                if (!aboveId) continue;
                return lookupSortId(aboveId) || aboveId;
            }
        }
        return tweetId;
    }

    function articleSortPosition(article) {
        const id = extractTweetId(article);
        if (id) {
            const mapped = lookupSortId(id);
            if (mapped) {
                try { return BigInt(mapped); } catch (_) { /* fall through */ }
            }
        }
        const iso = getTweetTime(article);
        if (iso) {
            const ms = Date.parse(iso);
            if (!isNaN(ms)) return snowflakeFromMs(ms);
        }
        if (id) {
            try { return BigInt(id); } catch (_) { /* ignore */ }
        }
        return null;
    }

    function targetSortPosition(saved) {
        const raw = (saved && (saved.sortId || saved.tweetId)) || null;
        if (!raw) return null;
        try { return BigInt(String(raw)); } catch (_) { return null; }
    }

    // Topmost tweet occupying the upper half of the viewport (including ones
    // partially tucked under the sticky mobile header where rect.top < 0).
    function getTopTweet() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let best = null;
        let bestTop = Infinity;
        const headerSlack = 80;
        const upper = window.innerHeight * 0.5;
        for (const article of articles) {
            const rect = article.getBoundingClientRect();
            if (rect.bottom <= headerSlack || rect.top >= upper) continue;
            if (rect.top < bestTop) {
                const id = extractTweetId(article);
                if (!id) continue;
                bestTop = rect.top;
                best = { id, time: getTweetTime(article), article };
            }
        }
        return best;
    }

    function findTweetById(id) {
        const links = document.querySelectorAll(`a[href*="/status/${id}"]`);
        for (const link of links) {
            const article = link.closest('article[data-testid="tweet"]');
            if (article) return article;
        }
        return null;
    }

    function newestMountedSortPosition() {
        let newest = null;
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const pos = articleSortPosition(article);
            if (pos == null) continue;
            if (newest == null || pos > newest) newest = pos;
        }
        return newest;
    }

    function formatTweetTime(iso) {
        if (!iso) return 'unknown time';
        const date = new Date(iso);
        return isNaN(date) ? iso : date.toLocaleString();
    }

    // ============ NAVIGATION TABS (For you / Following / Olo ...) ============

    function getTabLabel(tab) {
        const span = tab.querySelector('span');
        if (span && span.textContent.trim()) return span.textContent.trim();
        const text = (tab.innerText || tab.textContent || '').trim();
        return text || tab.getAttribute('aria-label') || null;
    }

    // Several tablists exist on the page; pick the one that looks like the timeline tab bar.
    function scoreTablist(tablist) {
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        const labels = tabs.map(getTabLabel).filter(Boolean);
        if (labels.length < 2) return -1;

        let score = labels.length;
        if (tabs.some(t => t.getAttribute('aria-selected') === 'true')) score += 5;

        const column = document.querySelector('[data-testid="primaryColumn"]');
        if (column) {
            if (column.contains(tablist)) {
                score += 10;
            } else {
                // On mobile the tab bar sits just above the timeline column.
                const t = tablist.getBoundingClientRect();
                const c = column.getBoundingClientRect();
                if (t.bottom <= c.top + 120 && t.top >= c.top - 160) score += 12;
            }
        }
        return score;
    }

    function getNavigationTabs() {
        let best = [];
        let bestScore = -1;
        document.querySelectorAll('[role="tablist"], [data-testid="ScrollSnap-List"]').forEach(list => {
            const score = scoreTablist(list);
            if (score > bestScore) {
                bestScore = score;
                best = Array.from(list.querySelectorAll('[role="tab"]'));
            }
        });
        return best;
    }

    function getCurrentTabLabel() {
        const tab = getNavigationTabs().find(t => t.getAttribute('aria-selected') === 'true');
        return tab ? getTabLabel(tab) : null;
    }

    function getTargetTabEl() {
        return getNavigationTabs().find(t => getTabLabel(t) === CONFIG.targetTab) || null;
    }

    function isOnTargetTab() {
        return getCurrentTabLabel() === CONFIG.targetTab;
    }

    // Switch to the "Olo" tab and confirm it is actually selected before returning.
    async function ensureTargetTab(ctrl, maxWaitMs = 8000) {
        const start = Date.now();

        let tab = getTargetTabEl();
        while (!tab && Date.now() - start < maxWaitMs) {
            if (ctrl.aborted) return false;
            await sleep(300);
            tab = getTargetTabEl();
        }
        if (!tab) return false;

        if (isOnTargetTab()) return true;

        tab.click();
        while (Date.now() - start < maxWaitMs) {
            if (ctrl.aborted) return false;
            if (isOnTargetTab()) return true;
            await sleep(200);
        }
        return isOnTargetTab();
    }

    // ============ SAVE / RESTORE ============

    let restoring = false;
    let currentAbort = null;

    // X sometimes yanks the timeline to the top when new tweets arrive. Distinguish
    // that from the user scrolling up (which should update the saved pin).
    // v3.32: require teleport from DEEP feed to NEAR TOP — not any upward scroll
    // that ends within one viewport (that false-fired while scrolling up on iOS).
    const USER_SCROLL_GRACE_MS = 800;
    const YANK_JUMP_PX = 250;
    let lastUserGestureAt = 0;
    let lastStableScrollY = 0;
    let lastStableTweetId = null;
    let suppressSaves = false;
    let yankRestoreCooldownUntil = 0;
    // After a successful land, first real user gesture disables our scroll writes
    // (yank undo / manual anchoring) so we never fight upward reading.
    let landedAwaitingUser = false;
    let userControlAfterLand = false;
    let touchActive = false;
    let landedTweetId = null;
    let landSettleTimer = 0;
    let landSettleCount = 0;
    let scrollIdleTimer = 0;
    let lastScrollIdleY = 0;

    function abortRestore() {
        if (currentAbort) currentAbort.aborted = true;
    }

    function noteUserGesture() {
        lastUserGestureAt = Date.now();
        if (suppressSaves) {
            suppressSaves = false;
            log('User scroll — resume saving');
        }
        if (landedAwaitingUser) {
            landedAwaitingUser = false;
            userControlAfterLand = true;
            cancelLandSettle('user-gesture');
            scrollLog('userControlAfterLand — no more settle/yank-undo writes');
            updateNearTopFlag();
        }
    }

    // A real scroll gesture during a search means the user took over: stop the
    // search so it does not drag the page back and so saving resumes at once.
    // Programmatic scrolling never fires wheel/touch/key events.
    function noteUserScroll() {
        noteUserGesture();
        if (restoring) abortRestore();
    }

    function userRecentlyScrolled() {
        return Date.now() - lastUserGestureAt < USER_SCROLL_GRACE_MS;
    }

    function rememberStablePosition() {
        lastStableScrollY = scrollTop();
        const top = getTopTweet();
        if (top) lastStableTweetId = top.id;
    }

    // Sticky header/tabs height so the landed tweet sits just below, not under it.
    function stickyHeaderOffset() {
        let bottom = 0;
        try {
            const nodes = document.querySelectorAll(
                'header[role="banner"], [data-testid="SwipeableList"], div[style*="position: sticky"], div[style*="position:sticky"]'
            );
            const vh = window.innerHeight || 800;
            for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                const r = el.getBoundingClientRect();
                if (r.top >= -1 && r.top < vh * 0.35 && r.bottom > bottom && r.bottom < vh * 0.5) {
                    bottom = r.bottom;
                }
            }
            // Fallback: primary column top bars often ~53–120px on mobile X.
            if (bottom < 40) bottom = window.innerWidth <= 500 ? 110 : 53;
        } catch (_) {
            bottom = 110;
        }
        return Math.round(bottom + 6);
    }

    function alignTweetBelowHeader(tweet, reason) {
        if (!tweet || userControlAfterLand) return false;
        try {
            const offset = stickyHeaderOffset();
            const top = tweet.getBoundingClientRect().top;
            const delta = top - offset;
            if (!isFinite(delta) || Math.abs(delta) < 2) return false;
            const before = scrollTop();
            tpsScrollWrite(reason || 'align-header', function () {
                window.scrollBy(0, delta);
            });
            scrollLog('idle: align', reason, 'delta=', Math.round(delta),
                'y', Math.round(before), '→', Math.round(scrollTop()), 'hdr=', offset);
            return true;
        } catch (_) {
            return false;
        }
    }

    function cancelLandSettle(why) {
        if (landSettleTimer) {
            try { clearTimeout(landSettleTimer); } catch (_) { /* ignore */ }
            landSettleTimer = 0;
        }
        landSettleCount = 0;
        if (why) scrollLog('idle: land-settle cancel', why);
    }

    // After land, X often reflows items above (~300px within ~1s). Re-align a few
    // times, then stop — never a continuous MutationObserver (that fights flings).
    function scheduleLandSettle(tweetId) {
        cancelLandSettle(null);
        landedTweetId = tweetId || landedTweetId;
        landSettleCount = 0;
        const step = function () {
            landSettleTimer = 0;
            if (userControlAfterLand || restoring) return;
            landSettleCount++;
            const before = scrollTop();
            scrollLog('idle: land-settle', landSettleCount, 'y=', Math.round(before));
            const el = landedTweetId && findTweetById(landedTweetId);
            if (el) alignTweetBelowHeader(el, 'land-settle-' + landSettleCount);
            scrollLog('idle: land-settle done step', landSettleCount,
                'y=', Math.round(scrollTop()));
            if (landSettleCount < 6 && !userControlAfterLand) {
                landSettleTimer = setTimeout(step, landSettleCount < 3 ? 200 : 350);
            }
        };
        landSettleTimer = setTimeout(step, 180);
    }

    function markLanded(tweetOrId) {
        landedAwaitingUser = true;
        userControlAfterLand = false;
        const id = typeof tweetOrId === 'string'
            ? tweetOrId
            : (tweetOrId && extractTweetId(tweetOrId)) || (getTopTweet() && getTopTweet().id);
        landedTweetId = id || landedTweetId;
        rememberStablePosition();
        scrollLog('markLanded', 'y=', lastStableScrollY, 'tweet=', landedTweetId,
            'hdr=', stickyHeaderOffset());
        scheduleLandSettle(landedTweetId);
    }

    function onScrollIdle() {
        scrollIdleTimer = 0;
        if (!TPS_DEBUG_SCROLL) return;
        const y = scrollTop();
        scrollLog('idle: scroll-end', 'y=', Math.round(y),
            'dy=', Math.round(lastScrollIdleY - y),
            'userControl=', userControlAfterLand,
            'touch=', touchActive,
            'lastWriter=', tpsLastScrollWriter);
        lastScrollIdleY = y;
    }

    function noteScrollForIdleDebug() {
        if (!TPS_DEBUG_SCROLL) return;
        lastScrollIdleY = scrollTop();
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(onScrollIdle, 140);
    }

    function undoXYank() {
        if (userControlAfterLand || landedAwaitingUser) {
            scrollLog('yank-undo skipped',
                userControlAfterLand ? '(userControl)' : '(land-settle)');
            return;
        }
        suppressSaves = true;
        if (Date.now() < yankRestoreCooldownUntil) return;
        yankRestoreCooldownUntil = Date.now() + 1000;
        log('Blocked X auto-jump; restoring position');
        scrollLog('yank-undo', 'to', lastStableTweetId || lastStableScrollY);

        const tweet = lastStableTweetId && findTweetById(lastStableTweetId);
        if (tweet) {
            tpsScrollWrite('yank-undo-siv', function () {
                tweet.scrollIntoView({ block: 'start', behavior: 'auto' });
            });
        } else {
            const y = lastStableScrollY;
            tpsScrollWrite('yank-undo-y', function () {
                scrollRoot().scrollTop = y;
                window.scrollTo(0, y);
            });
        }
    }

    function onTimelineScroll() {
        const y = scrollTop();
        const prev = lastStableScrollY;
        noteScrollForIdleDebug();
        updateNearTopFlag();

        // Debug: large jumps not from our recent write and not from a gesture.
        if (TPS_DEBUG_SCROLL) {
            const dy = prev - y;
            if (Math.abs(dy) > 40) {
                const ours = Date.now() < tpsOurScrollUntil;
                const gest = userRecentlyScrolled();
                if (!ours && !gest) {
                    scrollLog('jump', Math.round(dy) + 'px', 'y', Math.round(prev), '→', Math.round(y),
                        'lastWriter=', tpsLastScrollWriter, 'touch=', touchActive);
                }
            }
        }

        if (restoring) {
            rememberStablePosition();
            return;
        }
        if (!isTimelinePage() || !isOnTargetTab()) {
            lastStableScrollY = y;
            return;
        }

        const yank = isLikelyXYank(prev, y, window.innerHeight || 800);
        if (yank && !userRecentlyScrolled() && !userControlAfterLand) {
            scrollLog('yank-detect', 'prev', Math.round(prev), 'y', Math.round(y));
            undoXYank();
            return;
        }

        if (userRecentlyScrolled() || !suppressSaves) {
            rememberStablePosition();
        }
    }


    function savePosition() {
        if (restoring || suppressSaves) return;
        if (!isTimelinePage() || !isOnTargetTab()) return;

        const y0 = TPS_DEBUG_SCROLL ? scrollTop() : 0;
        const top = getTopTweet();
        if (!top) return;

        // Storage only — no DOM/history/focus/URL writes (those jump iOS).
        const sortId = resolveSortIdForArticle(top.article, top.id);
        gmSet(KEY_TWEET_ID, top.id);
        gmSet(KEY_TWEET_TIME, top.time);
        gmSet(KEY_SORT_ID, sortId);
        gmSet(KEY_TIMESTAMP, Date.now());
        gmSet(KEY_PATH, currentPath());
        const blocked = gmGet(KEY_JUMP_BLOCKED);
        if (blocked && String(blocked) !== String(top.id)) gmSet(KEY_JUMP_BLOCKED, '');
        log('Saved', top.id, top.time, 'sort', sortId);
        if (TPS_DEBUG_SCROLL) {
            scrollLog('idle: savePosition', top.id, 'y=', Math.round(y0), '→', Math.round(scrollTop()));
        }
    }

    function readSavedPosition() {
        const id = gmGet(KEY_TWEET_ID);
        const timestamp = gmGet(KEY_TIMESTAMP);
        if (!id || !timestamp) return null;
        const sortId = gmGet(KEY_SORT_ID);
        return {
            tweetId: id,
            tweetTime: gmGet(KEY_TWEET_TIME),
            sortId: sortId || id,
            timestamp,
            path: gmGet(KEY_PATH)
        };
    }

    // Arm as early as possible so the first ListLatestTweetsTimeline (which may
    // fire before restore()) can pick up the cursor. Expires in ~20s.
    try {
        if (CONFIG.autoRestore && CONFIG.cursorJump) {
            const earlySaved = readSavedPosition();
            // v3.42: after a reload mid-restore, do not arm again (restore()
            // shows "position too old" instead).
            if (earlySaved && isHomeTimelinePath(earlySaved.path || currentPath()) &&
                !restoreWasInterrupted() && !jumpBlockedFor(earlySaved)) {
                armCursorJump(earlySaved, 20000);
            }
        }
    } catch (_) { /* ignore */ }

    function highlight(tweet) {
        // outline does not affect layout (unlike box-shadow/margins).
        try {
            tweet.style.outline = '3px solid #1d9bf0';
            tweet.style.outlineOffset = '0px';
        } catch (_) { /* ignore */ }
        setTimeout(() => {
            const y0 = TPS_DEBUG_SCROLL ? scrollTop() : 0;
            try { tweet.style.outline = ''; tweet.style.outlineOffset = ''; } catch (_) { /* ignore */ }
            if (TPS_DEBUG_SCROLL) {
                scrollLog('idle: highlight-clear', 'y=', Math.round(y0), '→', Math.round(scrollTop()));
            }
        }, 2000);
    }

    function navigationType() {
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            return (nav && nav.type) || 'navigate';
        } catch (_) {
            return 'navigate';
        }
    }

    // A killed tab reloads the document and auto-restore would start again.
    function restoreWasInterrupted() {
        const startedAt = Number(gmGet(KEY_RESTORE_ACTIVE) || 0);
        if (!startedAt || Date.now() - startedAt > 3 * 60 * 1000) return false;
        return navigationType() === 'reload';
    }

    function jumpBlockedFor(saved) {
        const blocked = gmGet(KEY_JUMP_BLOCKED);
        return !!(blocked && saved && String(blocked) === String(saved.tweetId));
    }

    // v3.42: the page hook only answers X's "newer posts" request with fill-up
    // pages while the user is reading near the top (not during our search,
    // not for background polls).
    let lastNearTopFlag = null;
    function updateNearTopFlag() {
        let near = false;
        try {
            if (!restoring && (userControlAfterLand || !landedAwaitingUser) &&
                isTimelinePage() && isOnTargetTab()) {
                near = scrollTop() < 3 * (window.innerHeight || 800);
            }
        } catch (_) { near = false; }
        const v = near ? '1' : '0';
        if (v === lastNearTopFlag) return;
        lastNearTopFlag = v;
        try { document.documentElement.setAttribute('data-tps-near-top', v); } catch (_) { /* ignore */ }
    }

    // v3.44 fill nudge. X fetches newer posts only when the viewport ENTERS
    // the top zone of the list (top 25% of a screen) and only if its last
    // initial/"newer" response is older than 60 s (onlyIfStale); list
    // timelines do not poll. A reader who reaches the top of the restored
    // window within that minute (or just sits there) never triggers another
    // request: scrolling "blocks after a few posts". While the page hook
    // still has newer posts to give, nudge X:
    //  1. Home tap (AppTabBar_Home_Link). X's refreshOrGoTop: at the newest
    //     post it runs a refresh = Top fetch that is NOT stale-gated, so no
    //     60 s wait; otherwise it scrolls to the top (next tap refreshes).
    //  2. Fallback: scroll out of the top zone and back once X's 60 s are
    //     over (v3.43 kick; stale-gated near-top fetch).
    // v3.43 showed "Loading newer posts…" forever when its kick did not make
    // X ask. Now every nudge must be followed by a Top request reaching the
    // page hook within FILL_NUDGE_TIMEOUT_MS, else it is a miss and the other
    // method is tried; after FILL_NUDGE_MAX_MISSES misses in a row the pill
    // says so and retries every 30 s. Tap/long-press the pill: debug log.
    const X_TOP_STALE_MS = 60000;
    const FILL_KICK_MARGIN_MS = 1500;
    const FILL_ZONE_RATIO = 0.25;           // X nearStartProximityRatio
    const FILL_DWELL_MS = 400;
    const FILL_NUDGE_TIMEOUT_MS = 5000;
    const FILL_AFTER_ANSWER_MS = 1500;
    const FILL_HOME_MISSES_TO_SWITCH = 2;
    const FILL_NUDGE_MAX_MISSES = 6;
    const FILL_STUCK_RETRY_MS = 30000;
    const FILL_BUSY_SLOW_MS = 25000;
    const FILL_TICK_MS = 300;
    const FILL_WAIT_ID = 'tps-fill-wait';
    const FILL_LOG_ID = 'tps-fill-log';
    const FILL_UI_LOG_MAX = 30;
    const fillNudge = {
        pending: null,      // { method, n, at }
        method: 'home',     // next method to try
        misses: 0, homeMisses: 0, count: 0,
        homeOff: '',        // reason Home taps are disabled
        topSince: 0, lastAt: 0, stuckLogged: false, slowLogged: false,
        log: []
    };
    let lastFillKickAt = 0;
    let fillKickBusy = false;

    function fillUiLog(msg) {
        fillNudge.log.push(Date.now() + '|' + msg);
        while (fillNudge.log.length > FILL_UI_LOG_MAX) fillNudge.log.shift();
        try { log('fill: ' + msg); } catch (_) { /* ignore */ }
        renderFillLog();
    }

    function fillStillWanted() {
        let st = null;
        try { st = document.documentElement.getAttribute('data-tps-fill'); } catch (_) { return false; }
        if (!st) return false;
        return st === 'armed' || st === 'hold' || st === 'error' || st.indexOf('step') === 0;
    }

    function fillAttrNum(name) {
        try { return Number(document.documentElement.getAttribute(name)) || 0; } catch (_) { return 0; }
    }

    function fillBufText() {
        let b = '';
        try { b = document.documentElement.getAttribute('data-tps-fill-buf') || ''; } catch (_) { /* ignore */ }
        if (!b) return '';
        const parts = b.split('|');
        return parts[0] + ' ready' + (parts[1] === 'now' ? ', up to now' : '');
    }

    function homeLink() {
        try { return document.querySelector('a[data-testid="AppTabBar_Home_Link"]'); } catch (_) { return null; }
    }

    function showFillWait(text) {
        let el = document.getElementById(FILL_WAIT_ID);
        if (!text) { if (el) el.remove(); return; }
        if (!el) {
            if (!document.body) return;
            el = document.createElement('div');
            el.id = FILL_WAIT_ID;
            el.setAttribute('role', 'button');
            el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:92vw;' +
                'z-index:2147483646;background:rgba(29,155,240,.92);color:#fff;font:13px/1.3 -apple-system,' +
                'system-ui,sans-serif;padding:6px 12px;border-radius:14px;pointer-events:auto;cursor:pointer;' +
                'text-align:center;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';
            // Tap or long-press: show what the fill is waiting on.
            let pressTimer = 0;
            let pressed = false;
            el.addEventListener('touchstart', function () {
                pressed = false;
                clearTimeout(pressTimer);
                pressTimer = setTimeout(function () { pressed = true; toggleFillLog(true); }, 500);
            }, { passive: true });
            const cancelPress = function () { clearTimeout(pressTimer); };
            el.addEventListener('touchend', cancelPress, { passive: true });
            el.addEventListener('touchcancel', cancelPress, { passive: true });
            el.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (pressed) { pressed = false; return; }
                toggleFillLog();
            });
            el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            document.body.appendChild(el);
        }
        if (el.textContent !== text) el.textContent = text;
    }

    function fmtClock(ms) {
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function fillLogLines() {
        const de = document.documentElement;
        const now = Date.now();
        const lines = [];
        let hook = [];
        try { hook = JSON.parse(de.getAttribute('data-tps-fill-log') || '[]') || []; } catch (_) { hook = []; }
        const all = [];
        for (const e of hook) { const i = e.indexOf('|'); all.push([Number(e.slice(0, i)), 'hook', e.slice(i + 1)]); }
        for (const e of fillNudge.log) { const i = e.indexOf('|'); all.push([Number(e.slice(0, i)), 'saver', e.slice(i + 1)]); }
        all.sort((a, b) => a[0] - b[0]);
        const topAt = fillAttrNum('data-tps-top-at');
        const busyAt = fillAttrNum('data-tps-fill-busy');
        lines.push('Timeline Saver ' + TPS_VERSION + ' · newer posts');
        lines.push('fill=' + (de.getAttribute('data-tps-fill') || '-') +
            ' · buffer=' + (de.getAttribute('data-tps-fill-buf') || '0') +
            ' · near-top=' + (de.getAttribute('data-tps-near-top') || '-'));
        lines.push('last X request ' + (topAt ? Math.round((now - topAt) / 1000) + ' s ago' : 'never') +
            (busyAt ? ' · answering for ' + Math.round((now - busyAt) / 1000) + ' s' : '') +
            ' · y=' + Math.round(scrollTop()));
        lines.push('nudges=' + fillNudge.count + ' · misses in a row=' + fillNudge.misses +
            ' · next=' + (fillNudge.homeOff ? 'scroll (Home off: ' + fillNudge.homeOff + ')' : fillNudge.method) +
            (fillNudge.pending ? ' · waiting on ' + fillNudge.pending.method + ' #' + fillNudge.pending.n : ''));
        lines.push('—');
        for (const a of all.slice(-24)) lines.push(fmtClock(a[0]) + ' ' + (a[1] === 'hook' ? '· ' : '» ') + a[2]);
        return lines;
    }

    function renderFillLog() {
        const box = document.getElementById(FILL_LOG_ID);
        if (!box) return;
        const pre = box.querySelector('pre');
        if (pre) pre.textContent = fillLogLines().join('\n');
    }

    function toggleFillLog(forceOpen) {
        let box = document.getElementById(FILL_LOG_ID);
        if (box && !forceOpen) { clearInterval(box.__tpsTimer); box.remove(); return; }
        if (box) { renderFillLog(); return; }
        if (!document.body) return;
        box = document.createElement('div');
        box.id = FILL_LOG_ID;
        box.style.cssText = 'position:fixed;top:44px;left:6px;right:6px;max-height:62vh;overflow:auto;' +
            'z-index:2147483647;background:rgba(0,0,0,.94);color:#e7e9ea;border:1px solid #1d9bf0;' +
            'border-radius:10px;padding:8px;font:11px/1.35 ui-monospace,Menlo,monospace;' +
            '-webkit-overflow-scrolling:touch;';
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
        const mk = (label, fn) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'flex:1;font:13px -apple-system,system-ui,sans-serif;padding:6px;border-radius:8px;' +
                'border:0;background:#1d9bf0;color:#fff;';
            b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
            bar.appendChild(b);
            return b;
        };
        mk('Retry now', () => { resetFillNudge('retry button'); renderFillLog(); });
        const copyBtn = mk('Copy', () => {
            const t = fillLogLines().join('\n');
            try {
                navigator.clipboard.writeText(t).then(() => { copyBtn.textContent = 'Copied'; },
                    () => { copyBtn.textContent = 'Copy failed'; });
            } catch (_) { copyBtn.textContent = 'Copy failed'; }
        });
        mk('Close', () => toggleFillLog());
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;';
        box.appendChild(bar);
        box.appendChild(pre);
        box.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(box);
        renderFillLog();
        box.__tpsTimer = setInterval(() => {
            if (!document.getElementById(FILL_LOG_ID)) { clearInterval(box.__tpsTimer); return; }
            renderFillLog();
        }, 1000);
    }

    function resetFillNudge(why) {
        fillNudge.pending = null;
        fillNudge.misses = 0;
        fillNudge.homeMisses = 0;
        fillNudge.homeOff = '';
        fillNudge.method = 'home';
        fillNudge.lastAt = 0;
        fillNudge.stuckLogged = false;
        fillUiLog('reset (' + why + ')');
    }

    function fillNudgeMiss(p) {
        fillNudge.misses++;
        let next = p.method;
        if (p.method === 'home') {
            fillNudge.homeMisses++;
            if (fillNudge.homeMisses >= FILL_HOME_MISSES_TO_SWITCH) { next = 'scroll'; fillNudge.homeMisses = 0; }
        } else {
            next = 'home';
        }
        fillNudge.method = next;
        fillUiLog(p.method + ' #' + p.n + ': X did not ask within ' + (FILL_NUDGE_TIMEOUT_MS / 1000) +
            ' s (miss ' + fillNudge.misses + '/' + FILL_NUDGE_MAX_MISSES + '), next: ' +
            (fillNudge.homeOff ? 'scroll' : next));
    }

    function sendFillNudge(method, now) {
        fillNudge.count++;
        fillNudge.lastAt = now;
        const p = { method, n: fillNudge.count, at: now };
        fillNudge.pending = p;
        updateNearTopFlag();
        if (method === 'home') {
            const a = homeLink();
            fillUiLog('home #' + p.n + ': tap Home (X refresh, no 60 s wait) y=' + Math.round(scrollTop()));
            const tab0 = isOnTargetTab();
            try { a.click(); } catch (e) { fillUiLog('home tap error ' + (e && e.message)); }
            setTimeout(() => {
                // The tap must keep us on /home and the same tab.
                if (currentPath() !== '/home' || (tab0 && !isOnTargetTab())) {
                    fillNudge.homeOff = 'tap left the tab';
                    fillUiLog('Home tap changed page/tab — Home taps off for this page');
                }
            }, 800);
        } else {
            lastFillKickAt = now;
            fillUiLog('scroll #' + p.n + ': scroll out of the top zone and back (X near-top fetch)');
            kickNearTop();
        }
    }

    function fillKickTick() {
        try { fillTickInner(); } catch (e) { try { log('fill tick error', e && e.message); } catch (_) { /* */ } }
    }

    function fillTickInner() {
        const now = Date.now();
        const topAt = fillAttrNum('data-tps-top-at');
        const busyAt = fillAttrNum('data-tps-fill-busy');
        const p = fillNudge.pending;
        if (p) {
            if (busyAt >= p.at || topAt >= p.at) {
                fillUiLog(p.method + ' #' + p.n + ': X asked after ' + ((Math.max(busyAt, topAt) - p.at) / 1000).toFixed(1) + ' s');
                fillNudge.pending = null;
                fillNudge.misses = 0;
                fillNudge.stuckLogged = false;
                if (p.method === 'home') fillNudge.homeMisses = 0;
            } else if (now - p.at > FILL_NUDGE_TIMEOUT_MS) {
                fillNudge.pending = null;
                fillNudgeMiss(p);
            }
        }
        if (restoring || lastNearTopFlag !== '1' || !fillStillWanted()) {
            fillNudge.topSince = 0;
            showFillWait('');
            return;
        }
        const vh = window.innerHeight || 800;
        if (scrollTop() > FILL_ZONE_RATIO * vh) { fillNudge.topSince = 0; showFillWait(''); return; }
        if (!fillNudge.topSince) fillNudge.topSince = now;
        const buf = fillBufText();
        if (busyAt) {
            const w = now - busyAt;
            if (w > FILL_BUSY_SLOW_MS) {
                if (!fillNudge.slowLogged) { fillNudge.slowLogged = true; fillUiLog('answer slow: ' + Math.round(w / 1000) + ' s'); }
                showFillWait('Still loading newer posts (' + Math.round(w / 1000) + ' s, slow network)… tap for details');
            } else {
                showFillWait('Loading newer posts… (X asked' + (buf ? ', ' + buf : '') + ')');
            }
            return;
        }
        fillNudge.slowLogged = false;
        if (fillNudge.pending) {
            const q = fillNudge.pending;
            showFillWait('Asking X for newer posts (' + (q.method === 'home' ? 'Home tap' : 'scroll nudge') +
                ' #' + q.n + ', ' + Math.max(0, Math.ceil((q.at + FILL_NUDGE_TIMEOUT_MS - now) / 1000)) + ' s)…');
            return;
        }
        const stuck = fillNudge.misses >= FILL_NUDGE_MAX_MISSES;
        if (stuck) {
            if (!fillNudge.stuckLogged) {
                fillNudge.stuckLogged = true;
                fillUiLog('stuck: ' + fillNudge.misses + ' nudges in a row got no request from X; retry every ' +
                    (FILL_STUCK_RETRY_MS / 1000) + ' s');
            }
            const left = Math.ceil((fillNudge.lastAt + FILL_STUCK_RETRY_MS - now) / 1000);
            showFillWait('X is not loading newer posts (retry in ' + Math.max(0, left) + ' s). Tap for details / retry');
            if (now - fillNudge.lastAt < FILL_STUCK_RETRY_MS) return;
        }
        if (now - fillNudge.topSince < FILL_DWELL_MS) return;
        if (topAt && now - topAt < FILL_AFTER_ANSWER_MS) {
            if (!stuck) showFillWait('Loading newer posts…' + (buf ? ' (' + buf + ')' : ''));
            return;
        }
        if (fillKickBusy || touchActive || now - lastUserGestureAt < 700) {
            if (!stuck) showFillWait('Newer posts load when you stop scrolling');
            return;
        }
        let method = fillNudge.method;
        if (fillNudge.homeOff || !homeLink() || currentPath() !== '/home') method = 'scroll';
        if (method === 'scroll') {
            const due = topAt + X_TOP_STALE_MS + FILL_KICK_MARGIN_MS;
            if (now < due) {
                if (!stuck) {
                    showFillWait('Newer posts in ' + Math.ceil((due - now) / 1000) +
                        ' s (X allows one request a minute)' + (buf ? ' · ' + buf : ''));
                }
                return;
            }
        }
        sendFillNudge(method, now);
    }

    function nextFrames(n) {
        return new Promise((resolve) => {
            const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
            requestAnimationFrame(step);
        });
    }

    async function kickNearTop() {
        fillKickBusy = true;
        try {
            const y = scrollTop();
            const out = y + Math.ceil(0.75 * (window.innerHeight || 800));
            scrollLog('fill-kick', 'y=', Math.round(y));
            tpsScrollWrite('fill-kick-out', function () { window.scrollTo(0, out); });
            await new Promise((resolve) => {
                const t = setTimeout(resolve, 200);
                window.addEventListener('scroll', function once() { clearTimeout(t); resolve(); },
                    { once: true, passive: true });
            });
            await nextFrames(2);
            if (touchActive || Date.now() - lastUserGestureAt < 300) return; // user took over
            tpsScrollWrite('fill-kick-back', function () { window.scrollTo(0, y); });
        } finally {
            fillKickBusy = false;
        }
    }

    // Human-readable jump result for the panel.
    let lastJumpSummary = '';
    function describeJumpResult(code) {
        if (!code) return '';
        let m = /^merge:ok p=(\d+) n=(\d+)/.exec(code);
        if (m) return 'merged from the top: ' + m[1] + ' pages, ' + m[2] + ' posts';
        m = /^window:ok p=(\d+) n=(\d+)(?: \((.*)\))?/.exec(code);
        if (m) {
            const why = m[3] || '';
            let extra = '';
            const deep = /^deep~(\d+)/.exec(why);
            if (deep) extra = ' (~' + deep[1] + ' posts below the top)';
            else if (/^not-reached/.test(why)) extra = ' (merge from the top did not reach it)';
            else if (why) extra = ' (' + why + ')';
            return 'window around the post: ' + m[1] + ' pages, ' + m[2] + ' posts' + extra;
        }
        m = /^merge:fallback\((.*)\)$/.exec(code);
        if (m) return 'fallback: one page near the post (' + m[1] + ')';
        if (code === 'merge:busy') return 'loading…';
        return code;
    }

    // Resolve target index in merged order (newest-first position ids).
    // sortMap is displayedId → positionId (not the reverse).
    function resolveOrderIndex(order, tweetId, sortId, sortMap) {
        if (!order || !order.length) return { idx: -1, how: 'empty', approx: false };
        const tid = String(tweetId || '');
        const sid = String(sortId || tweetId || '');
        let idx = order.indexOf(tid);
        if (idx >= 0) return { idx: idx, how: 'tweetId', approx: false };
        if (sid && sid !== tid) {
            idx = order.indexOf(sid);
            if (idx >= 0) return { idx: idx, how: 'sortId', approx: false };
        }
        const sm = sortMap && typeof sortMap === 'object' ? sortMap : null;
        function mapPos(key) {
            if (!sm || key == null) return null;
            const v = sm[String(key)];
            if (v == null || typeof v === 'object' || Array.isArray(v) || v === true || v === false) return null;
            return String(v);
        }
        const posFromTweet = mapPos(tid);
        if (posFromTweet) {
            idx = order.indexOf(posFromTweet);
            if (idx >= 0) return { idx: idx, how: 'mapTweet', approx: false };
        }
        if (sid && sid !== tid) {
            const posFromSort = mapPos(sid);
            if (posFromSort) {
                idx = order.indexOf(posFromSort);
                if (idx >= 0) return { idx: idx, how: 'mapSort', approx: false };
            }
        }
        // Insertion point: first order entry with position <= targetPos (newest-first).
        let targetPos = null;
        try {
            if (posFromTweet) targetPos = BigInt(posFromTweet);
        } catch (_) { /* ignore */ }
        if (targetPos == null) {
            try { targetPos = BigInt(sid || tid); } catch (_) {
                return { idx: -1, how: 'none', approx: false };
            }
        }
        for (let i = 0; i < order.length; i++) {
            try {
                if (BigInt(order[i]) <= targetPos) {
                    return { idx: i, how: 'insert', approx: true };
                }
            } catch (_) { /* ignore */ }
        }
        return { idx: order.length - 1, how: 'insert-end', approx: true };
    }

    function readJumpResultCode() {
        try {
            return document.documentElement.getAttribute('data-tps-jump-result') || '';
        } catch (_) {
            return '';
        }
    }

    function readHookInfo() {
        try {
            const raw = document.documentElement.getAttribute('data-tps-hook') || '';
            if (!raw) return null;
            const parts = String(raw).split('|');
            return { version: parts[0] || '', realm: parts[1] || '' };
        } catch (_) {
            return null;
        }
    }

    function finishWithCode(text, code) {
        const suffix = code ? ' [' + code + ']' : '';
        const summary = lastJumpSummary ? ' · ' + lastJumpSummary : '';
        return finishPanel(text + suffix + summary);
    }


    function landTweet(tweet, timeStr, code) {
        tpsScrollWrite('land', function () {
            try {
                tweet.scrollIntoView({ behavior: 'instant', block: 'start' });
            } catch (_) {
                try { tweet.scrollIntoView({ block: 'start' }); } catch (__) { /* ignore */ }
            }
            // Place tweet top just below sticky header (not a blind -12px).
            try {
                const offset = stickyHeaderOffset();
                const delta = tweet.getBoundingClientRect().top - offset;
                if (isFinite(delta) && Math.abs(delta) > 1) window.scrollBy(0, delta);
            } catch (_) { /* ignore */ }
        });
        highlight(tweet);
        markLanded(tweet);
        return finishWithCode('Jumped to tweet from ' + timeStr, code || 'pos:ok');
    }

    // After estimate loop misses: step ~0.8 viewport toward target using order indices.
    async function searchMergedByOrder(saved, ctrl, timeStr, order, idx, codePrefix) {
        const maxSteps = 40;
        updatePanel('Near-search after merge… [' + (codePrefix || 'pos:near') + ']');
        for (let step = 1; step <= maxSteps && !ctrl.aborted; step++) {
            const tweet = findTweetById(saved.tweetId);
            if (tweet) return landTweet(tweet, timeStr, 'pos:near');

            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            let minI = Infinity;
            let maxI = -Infinity;
            for (let a = 0; a < articles.length; a++) {
                const id = extractTweetId(articles[a]);
                if (!id) continue;
                let oi = order.indexOf(id);
                if (oi < 0) {
                    const mapped = lookupSortId(id);
                    if (mapped) oi = order.indexOf(String(mapped));
                }
                if (oi < 0) continue;
                if (oi < minI) minI = oi;
                if (oi > maxI) maxI = oi;
            }

            let dirDown = true;
            if (minI !== Infinity) {
                if (idx < minI) dirDown = false; // need newer → scroll up
                else if (idx > maxI) dirDown = true;
                else {
                    // Target index is within mounted range but article not found
                    // (original id of a repost, etc.) — nudge down then up.
                    dirDown = step % 2 === 1;
                }
            }

            await paceStep(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (userControlAfterLand) return finishPanel('Stopped');

            // v3.41: one paced write via scrollByNudge. Before, this wrote
            // root.scrollTop AND window.scrollBy on the same scroller (2x
            // 0.8 screen every ~180ms ≈ 9 screens/s), faster than X can
            // unmount old posts on iOS → tab killed on deep (multi-day) restores.
            if (await holdForMountedCap(ctrl) === 'aborted') return finishPanel('Stopped');
            if (mountedTweetCount() > (CONFIG.maxMountedTweets || 100)) {
                return finishWithCode('Stopped — too many posts mounted', 'pos:capped');
            }
            const nudge = dirDown ? stepNudge() : -Math.round(stepNudge() * 0.8);
            tpsScrollWrite(dirDown ? 'near-down' : 'near-up', function () {
                scrollByNudge(nudge);
            });

            updatePanel(
                (dirDown ? 'Searching down' : 'Searching up') +
                ' after merge (step ' + step + '/' + maxSteps + ')…'
            );
            await waitForStep(saved.tweetId, ctrl, currentTweetIds());
            await waitForVirtualizer(ctrl);
        }
        if (ctrl.aborted) return finishPanel('Stopped');
        return finishWithCode(
            'Merged jump OK but post not found from ' + timeStr,
            'pos:missed'
        );
    }

    // After a merged jump, X renders from the top of a deep timeline. Use the
    // published order list to estimate scroll position, correct from mounted
    // articles, and land on the saved tweet near the top of the viewport.
    // Never returns 'continue' into a from-top search.
    async function positionMergedJump(saved, ctrl, timeStr) {
        const meta = await waitForJumpOrder(ctrl, 8000);
        if (ctrl.aborted) return finishPanel('Stopped');
        if (!meta || !meta.order || !meta.order.length) {
            jumpLog('positionMergedJump: no order list');
            updatePanel('Merged but no order… [pos:notInOrder]');
            return finishWithCode(
                'Merged jump but timeline order missing',
                'pos:notInOrder'
            );
        }

        const order = meta.order;
        const N = order.length;
        const tweetId = String(saved.tweetId);
        const sortId = String(saved.sortId || saved.tweetId);
        const sm = readSortMap();
        const resolved = resolveOrderIndex(order, tweetId, sortId, sm);
        let idx = resolved.idx;

        if (idx < 0) {
            jumpLog('positionMergedJump: target not in order', tweetId, sortId, 'N=', N);
            updatePanel('Target not in order… [pos:notInOrder]');
            return searchMergedByOrder(saved, ctrl, timeStr, order, Math.floor(N / 2), 'pos:notInOrder');
        }

        const approxTag = resolved.approx ? 'approx:' + resolved.how : resolved.how;
        jumpLog('positionMergedJump start idx=', idx, '/', N, 'how=', resolved.how,
            'pages=', meta.pages);
        updatePanel('Positioning (' + (idx + 1) + '/' + N + ', ' + approxTag + ')… [' +
            (readJumpResultCode() || 'merge:ok') + ']');

        const maxIters = 10;
        for (let iter = 0; iter < maxIters && !ctrl.aborted; iter++) {
            const landed = findTweetById(saved.tweetId);
            if (landed) {
                if (ctrl.aborted) return finishPanel('Stopped');
                if (userControlAfterLand) return finishPanel('Stopped');
                const again = findTweetById(saved.tweetId) || landed;
                return landTweet(again, timeStr, 'pos:ok');
            }

            const root = scrollRoot();
            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            const mounted = [];
            for (let a = 0; a < articles.length; a++) {
                const id = extractTweetId(articles[a]);
                if (!id) continue;
                let oi = order.indexOf(id);
                if (oi < 0) {
                    const mapped = lookupSortId(id);
                    if (mapped) oi = order.indexOf(String(mapped));
                }
                if (oi < 0) continue;
                const rect = articles[a].getBoundingClientRect();
                mounted.push({
                    el: articles[a],
                    id: id,
                    i: oi,
                    top: rect.top,
                    height: rect.height || 1
                });
            }

            let scrollTarget = null;
            const scrollable = Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || 0));

            if (mounted.length >= 1) {
                let sumH = 0;
                for (let m = 0; m < mounted.length; m++) sumH += mounted[m].height;
                const avgH = sumH / mounted.length;
                mounted.sort(function (x, y) { return x.i - y.i; });
                const ref = mounted[Math.floor(mounted.length / 2)];
                const refDocTop = (root.scrollTop || 0) + ref.top;
                scrollTarget = refDocTop + (idx - ref.i) * avgH;
                if (scrollable > avgH * N * 0.25) {
                    const fracY = (idx / Math.max(1, N - 1)) * scrollable;
                    scrollTarget = 0.65 * scrollTarget + 0.35 * fracY;
                }
                jumpLog('position iter', iter, 'mounted=', mounted.length,
                    'refI=', ref.i, 'avgH=', Math.round(avgH), 'targetY=', Math.round(scrollTarget));
            } else if (scrollable > 0) {
                scrollTarget = (idx / Math.max(1, N - 1)) * scrollable;
                jumpLog('position iter', iter, 'no mounted; fracY=', Math.round(scrollTarget));
            } else {
                jumpLog('position iter', iter, 'waiting for timeline height');
                await sleep(200);
                continue;
            }

            // v3.42: paced like the searches (min step gap, mounted cap,
            // wait for X to render) instead of back-to-back 150ms writes.
            await paceStep(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (userControlAfterLand) return finishPanel('Stopped');
            const hold = await holdForMountedCap(ctrl);
            if (hold === 'aborted') return finishPanel('Stopped');
            if (hold === 'capped') return finishWithCode('Stopped — too many posts mounted', 'pos:capped');
            const knownIds = currentTweetIds();
            tpsScrollWrite('pos-estimate', function () {
                try { root.scrollTop = Math.max(0, scrollTarget); } catch (_) { /* ignore */ }
                try { window.scrollTo(0, Math.max(0, scrollTarget)); } catch (_) { /* ignore */ }
            });

            await waitForStep(saved.tweetId, ctrl, knownIds);
            if (ctrl.aborted) return finishPanel('Stopped');
            updatePanel('Positioning… (' + (iter + 1) + '/' + maxIters + ')' +
                (lastJumpSummary ? ' · ' + lastJumpSummary : ''));
        }

        if (ctrl.aborted) return finishPanel('Stopped');
        const last = findTweetById(saved.tweetId);
        if (last) {
            if (ctrl.aborted) return finishPanel('Stopped');
            if (userControlAfterLand) return finishPanel('Stopped');
            const again = findTweetById(saved.tweetId) || last;
            return landTweet(again, timeStr, 'pos:ok');
        }

        jumpLog('positionMergedJump estimate missed — order near-search');
        return searchMergedByOrder(saved, ctrl, timeStr, order, idx, 'pos:near');
    }

    // After a cursor jump, search a limited number of steps toward the target.
    // Returns a finishPanel() result, or 'continue' to fall through to full search.
    async function searchNearJump(saved, ctrl, timeStr) {
        const target = targetSortPosition(saved);
        const newest = newestMountedSortPosition();
        let dirUp = target != null && newest != null && target > newest;
        const maxSteps = 20;

        updatePanel(
            dirUp
                ? `Jump landed below — searching up for tweet from ${timeStr}`
                : `Jump landed nearby — searching for tweet from ${timeStr}`
        );

        for (let attempt = 1; attempt <= maxSteps && !ctrl.aborted; attempt++) {
            const tweet = findTweetById(saved.tweetId);
            if (tweet) {
                tpsScrollWrite('land-near', function () {
                    tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                highlight(tweet);
                markLanded(tweet);
                log('Found near jump', saved.tweetId);
                return finishPanel(`Jumped near tweet from ${timeStr}`);
            }

            if (!dirUp && passedTarget(saved)) dirUp = true;

            allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 2000);
            await paceStep(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            if (dirUp) {
                updatePanel(`Searching up near jump (step ${attempt}/${maxSteps})`);
                scrollUpStep();
                await waitForStep(saved.tweetId, ctrl, currentTweetIds());
            } else {
                updatePanel(`Searching down near jump (step ${attempt}/${maxSteps})`);
                const outcome = await scrollDownAndWait(saved.tweetId, ctrl);
                if (outcome === 'aborted') return finishPanel('Stopped');
                if (outcome === 'end' || outcome === 'timeout') {
                    // Nothing older — try the other direction once.
                    dirUp = true;
                }
            }
            await waitForVirtualizer(ctrl);
        }

        if (ctrl.aborted) return finishPanel('Stopped');
        return finishPanel('Jumped near the post, but it was not on the page');
    }

    async function restore(saved) {
        if (!saved) return;

        const interrupted = restoreWasInterrupted();
        const crashes = interrupted ? Number(gmGet(KEY_RESTORE_CRASHES) || 0) + 1 : 0;
        gmSet(KEY_RESTORE_CRASHES, crashes);
        gentleRestore = crashes > 0;
        lastJumpSummary = '';

        // v3.42: one reload during a restore is enough — the saved post is too
        // deep for this device. Do not re-arm the jump (that was the reload
        // loop); keep the user on the timeline with a clear message.
        if (crashes >= 1 || jumpBlockedFor(saved)) {
            gmSet(KEY_RESTORE_ACTIVE, 0);
            gmSet(KEY_RESTORE_CRASHES, 0);
            gmSet(KEY_JUMP_BLOCKED, String(saved.tweetId));
            try { document.documentElement.removeAttribute('data-tps-jump'); } catch (_) { /* ignore */ }
            updateNearTopFlag();
            return finishWithCode(
                'Pozycja za stara / position too old (' + formatTweetTime(saved.tweetTime) +
                ') — the tab reloaded while restoring it. Not jumping again; scroll manually.',
                'crash:skip'
            );
        }
        gmSet(KEY_RESTORE_ACTIVE, Date.now());

        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;
        userControlAfterLand = false;
        landedAwaitingUser = false;
        cancelLandSettle('restore-start');
        updateNearTopFlag();

        const timeStr = formatTweetTime(saved.tweetTime);
        const wantJump = CONFIG.cursorJump && isHomeTimelinePath(saved.path || currentPath());
        // Arm before the Olo tab request fires (also armed at script start).
        if (wantJump) armCursorJump(saved, 20000);

        showPanel(gentleRestore
            ? `Switching to "${CONFIG.targetTab}" tab… (slower, after a reload)`
            : `Switching to "${CONFIG.targetTab}" tab…`);
        allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 5000);

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            if (saved.path && saved.path !== currentPath()) {
                log('Saved position is on a different page, skipping scroll');
                return finishPanel(`On "${CONFIG.targetTab}"`);
            }

            let jumpedNear = false;
            let mergeSucceeded = false;
            let jumpLate = false;

            if (wantJump) {
                // Wait briefly for page-realm hook (Gear inject can lag).
                let hookInfo = readHookInfo();
                if (!hookInfo) {
                    updatePanel('Waiting for page hook…');
                    for (let i = 0; i < 40 && !readHookInfo(); i++) {
                        if (ctrl.aborted) return finishPanel('Stopped');
                        await sleep(50);
                    }
                    hookInfo = readHookInfo();
                }
                if (!hookInfo) {
                    jumpLog('Page hook missing — search from top');
                    updatePanel('No page hook… [hook:missing]');
                    // Fall through to from-top search with visible reason at end.
                } else {
                    jumpLog('Hook present', hookInfo.version, hookInfo.realm);
                }

                updatePanel('Jumping near tweet from ' + timeStr + '…');
                const jumpWaitMs = CONFIG.jumpMerge === false ? 2500 : 15000;
                let used = jumpWasUsed() || await waitForJumpUsed(ctrl, jumpWaitMs);
                if (ctrl.aborted) return finishPanel('Stopped');

                // Timeline may have loaded before the hook was armed — try one
                // tab switch away and back to force a fresh ListLatestTweetsTimeline.
                if (!used && hookInfo) {
                    jumpLate = true;
                    jumpLog('Jump not consumed; trying tab-switch refetch');
                    updatePanel('Refreshing for jump… [jump:late]');
                    armCursorJump(saved, 15000);
                    const refetched = await refetchTargetTabWithJump(saved, ctrl);
                    if (ctrl.aborted) return finishPanel('Stopped');
                    if (refetched) {
                        used = jumpWasUsed() || await waitForJumpUsed(ctrl, jumpWaitMs);
                    }
                }

                if (used) {
                    // Merged path chains many pages — wait until hook clears busy.
                    if (jumpIsBusy()) {
                        updatePanel('Loading timeline…' + (jumpLate ? ' [jump:late]' : ''));
                        jumpLog('Waiting for jump merge to finish…');
                        await waitForJumpIdle(ctrl, 90000);
                        if (ctrl.aborted) return finishPanel('Stopped');
                    }
                    const resultCode = readJumpResultCode();
                    lastJumpSummary = describeJumpResult(resultCode);
                    const mergedHint = jumpWasMerged() || /^(merge|window):ok\b/.test(resultCode);
                    updatePanel(
                        (mergedHint ? 'Positioning tweet from ' : 'Jumping near tweet from ') +
                        timeStr + '…' +
                        (resultCode ? ' [' + resultCode + ']' : '') +
                        (jumpLate ? ' [jump:late]' : '')
                    );
                    await waitForContentToSettle(ctrl);
                    if (ctrl.aborted) return finishPanel('Stopped');

                    if (!mergedHint) {
                        for (let i = 0; i < 30 && !jumpWasMerged(); i++) {
                            if (ctrl.aborted) return finishPanel('Stopped');
                            await sleep(100);
                            if (jumpWasMerged()) break;
                        }
                    } else {
                        await sleep(150);
                    }

                    if (jumpWasMerged() || /^(merge|window):ok\b/.test(readJumpResultCode())) {
                        mergeSucceeded = true;
                        jumpedNear = true;
                        jumpLog('Using merged-jump positioning');
                        // Never fall through to from-top search after a merged jump.
                        return await positionMergedJump(saved, ctrl, timeStr);
                    }

                    for (let i = 0; i < 20 && !findTweetById(saved.tweetId); i++) {
                        if (ctrl.aborted) return finishPanel('Stopped');
                        await sleep(100);
                    }
                    const landed = findTweetById(saved.tweetId);
                    if (landed) {
                        tpsScrollWrite('land-fallback', function () {
                            landed.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        });
                        highlight(landed);
                        markLanded(landed);
                        jumpLog('Jumped to', saved.tweetId);
                        const fb = readJumpResultCode() || 'merge:fallback(single)';
                        lastJumpSummary = describeJumpResult(fb);
                        return finishWithCode('Jumped near tweet from ' + timeStr, fb);
                    }

                    jumpedNear = true;
                    const nearResult = await searchNearJump(saved, ctrl, timeStr);
                    if (nearResult !== 'continue') return nearResult;
                } else {
                    jumpLog('Jump unused; falling back to scroll search from top');
                    updatePanel('Jump unused — searching from top… [jump:unused]');
                }
            }

            // Never scroll from top after a successful merge (handled above by return).
            if (!jumpedNear && !mergeSucceeded) {
                tpsScrollWrite('search-top', function () {
                    scrollRoot().scrollTop = 0;
                    window.scrollTo(0, 0);
                });
                await waitForContentToSettle(ctrl);
                if (ctrl.aborted) return finishPanel('Stopped');
            }

            let stuckSteps = 0;
            let endSteps = 0;
            let capHolds = 0;
            let lastDir = 'down';
            let passCrossings = 0;
            const maxAttempts = jumpedNear
                ? Math.min(30, CONFIG.maxScrollAttempts)
                : CONFIG.maxScrollAttempts;

            for (let attempt = 1; attempt <= maxAttempts && !ctrl.aborted; attempt++) {
                let tweet = findTweetById(saved.tweetId);

                if (!tweet && passedTarget(saved)) {
                    if (lastDir !== 'up') {
                        passCrossings++;
                        if (passCrossings >= 4) break;
                    }
                    lastDir = 'up';
                    updatePanel(`Went past the tweet — scrolling back (step ${attempt})`);
                    await paceStep(ctrl);
                    if (ctrl.aborted) break;
                    scrollUpStep();
                    await waitForStep(saved.tweetId, ctrl, currentTweetIds());
                    await waitForVirtualizer(ctrl);
                    continue;
                }

                if (!tweet) {
                    lastDir = 'down';
                    updatePanel(
                        jumpedNear
                            ? `Searching near jump for tweet from ${timeStr} (step ${attempt})`
                            : `Searching for tweet from ${timeStr} (step ${attempt})`
                    );
                    allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 2000);

                    const outcome = await scrollDownAndWait(saved.tweetId, ctrl);
                    if (outcome === 'aborted') break;

                    tweet = findTweetById(saved.tweetId);
                    if (tweet) {
                        // fall through
                    } else if (outcome === 'end' || outcome === 'timeout') {
                        endSteps++;
                        stuckSteps = 0;
                        if (endSteps >= CONFIG.endConfirmAttempts) break;
                        updatePanel(
                            `Still loading… retry ${endSteps}/${CONFIG.endConfirmAttempts} for tweet from ${timeStr}`
                        );
                        await sleep(CONFIG.endRetryDelayMs);
                        scrollDownStep();
                        continue;
                    } else if (outcome === 'capped') {
                        endSteps = 0;
                        stuckSteps = 0;
                        capHolds++;
                        if (capHolds >= 8) {
                            return finishPanel(
                                `Stopped — ${mountedTweetCount()} posts still mounted (limit ${CONFIG.maxMountedTweets})`
                            );
                        }
                        updatePanel(
                            `Holding at ${mountedTweetCount()} posts (limit ${CONFIG.maxMountedTweets})`
                        );
                        await sleep(400);
                        continue;
                    } else if (outcome === 'stuck') {
                        endSteps = 0;
                        if (++stuckSteps >= CONFIG.stuckConfirmAttempts) break;
                        updatePanel(
                            `Stuck — retry ${stuckSteps}/${CONFIG.stuckConfirmAttempts} for tweet from ${timeStr}`
                        );
                        await sleep(CONFIG.endRetryDelayMs);
                        continue;
                    } else {
                        endSteps = 0;
                        stuckSteps = 0;
                        capHolds = 0;
                        continue;
                    }
                }

                tpsScrollWrite('land-search', function () {
                    tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                highlight(tweet);
                markLanded(tweet);
                log('Restored to', saved.tweetId);
                return finishPanel(
                    jumpedNear
                        ? `Jumped near tweet from ${timeStr}`
                        : `Found tweet from ${timeStr}`
                );
            }

            if (ctrl.aborted) return finishPanel('Stopped');
            if (jumpedNear) {
                return finishWithCode('Jumped near the post, but it was not on the page', 'pos:missed');
            }
            let failCode = 'search:miss';
            if (!readHookInfo()) failCode = 'hook:missing';
            else if (wantJump && !jumpWasUsed()) failCode = 'jump:unused';
            else {
                const rc = readJumpResultCode();
                if (rc && rc.indexOf('merge:fallback') === 0) failCode = rc;
            }
            return finishWithCode('Tweet from ' + timeStr + ' not found', failCode);
        } finally {
            restoring = false;
            gentleRestore = false;
            gmSet(KEY_RESTORE_ACTIVE, 0);
            gmSet(KEY_RESTORE_CRASHES, 0);
            if (currentAbort === ctrl) currentAbort = null;
            updateNearTopFlag();
        }
    }

    function scrollRoot() {
        return document.scrollingElement || document.documentElement;
    }

    function scrollTop() {
        return scrollRoot().scrollTop;
    }

    function isAtScrollBottom() {
        const root = scrollRoot();
        return root.scrollTop + window.innerHeight >= root.scrollHeight - 2;
    }

    function currentTweetIds() {
        const ids = new Set();
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const id = extractTweetId(article);
            if (id) ids.add(id);
        }
        return ids;
    }

    function hasNewTweet(knownIds) {
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const id = extractTweetId(article);
            if (id && !knownIds.has(id)) return true;
        }
        return false;
    }

    // Lowest tweet still visible — anchor for triggering the next batch load.
    function getBottomVisibleTweet() {
        let bottomTweet = null;
        let maxBottom = -1;
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const rect = article.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
            if (rect.bottom > maxBottom) {
                maxBottom = rect.bottom;
                bottomTweet = article;
            }
        }
        return bottomTweet;
    }

    function stepNudge() {
        const ratio = gentleRestore ? CONFIG.stepViewportRatio * 0.7 : CONFIG.stepViewportRatio;
        return Math.max(120, Math.round(window.innerHeight * ratio));
    }

    async function paceStep(ctrl) {
        const gap = gentleRestore ? CONFIG.minStepGapMs * 2 : CONFIG.minStepGapMs;
        const wait = lastScrollStepAt + gap - Date.now();
        if (wait > 0) await sleep(wait);
        if (ctrl && ctrl.aborted) return;
        lastScrollStepAt = Date.now();
    }

    // One short move on the real scroll root. scrollIntoView plus a second
    // scrollBy jumped about two screens and skipped tweets X had already unmounted.
    function scrollByNudge(dy) {
        allowProgrammaticScroll(2000);
        const root = scrollRoot();
        const next = Math.max(0, root.scrollTop + dy);
        root.scrollTop = next;
        if (root !== document.body && root !== document.documentElement && root !== document.scrollingElement) {
            return;
        }
        const winY = window.scrollY || window.pageYOffset || 0;
        if (Math.abs(winY - next) > 2) window.scrollTo(0, next);
    }

    function scrollDownStep() {
        scrollByNudge(stepNudge());
    }

    function scrollUpStep() {
        scrollByNudge(-Math.round(stepNudge() * 0.8));
    }

    function mountedTweetCount() {
        return document.querySelectorAll('article[data-testid="tweet"]').length;
    }

    async function waitForVirtualizer(ctrl) {
        const cap = CONFIG.maxMountedTweets || 100;
        const start = Date.now();
        while (Date.now() - start < 2500) {
            if (ctrl && ctrl.aborted) return;
            if (mountedTweetCount() <= cap) return;
            await sleep(80);
        }
    }

    // Do not scroll further while more than maxMountedTweets are mounted.
    // Near the top, X often mounts a first batch before virtualizing, so the
    // search is allowed to start. Deeper in, nudge up so off-screen tweets drop.
    async function holdForMountedCap(ctrl) {
        const cap = CONFIG.maxMountedTweets || 100;
        for (let pass = 0; pass < 3; pass++) {
            const start = Date.now();
            while (Date.now() - start < 1500) {
                if (ctrl && ctrl.aborted) return 'aborted';
                if (mountedTweetCount() <= cap) return 'ok';
                await sleep(80);
            }
            if (scrollTop() < window.innerHeight) return 'ok';
            if (ctrl && ctrl.aborted) return 'aborted';
            scrollByNudge(-Math.round(stepNudge() * 0.6));
            await sleep(200);
        }
        if (ctrl && ctrl.aborted) return 'aborted';
        return mountedTweetCount() <= cap ? 'ok' : 'capped';
    }

    // Every mounted tweet is older (by timeline sort position) than the saved
    // pin, so we scrolled past it. Prefer sortIndex / sortId over wall-clock
    // tweetTime so reposts compare correctly.
    function passedTarget(saved) {
        const target = targetSortPosition(saved);
        if (target == null) return false;
        let newest = null;
        let count = 0;
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const pos = articleSortPosition(article);
            if (pos == null) continue;
            count++;
            if (newest == null || pos > newest) newest = pos;
        }
        if (count < 3 || newest == null) return false;
        const margin = BigInt(60 * 1000) << 22n; // ~1 minute of snowflake space
        return newest + margin < target;
    }

    // Advance as soon as a new tweet id renders (content loaded). Fall back to the
    // hard cap / true bottom-of-feed — no fixed settle delay.
    async function waitForStep(targetId, ctrl, knownIds) {
        const start = Date.now();
        let bottomSince = null;
        let bottomHeight = null;

        while (Date.now() - start < CONFIG.stepMaxWaitMs) {
            if (ctrl.aborted) return 'aborted';
            if (targetId && findTweetById(targetId)) return 'found';
            if (knownIds && hasNewTweet(knownIds)) return 'loaded';

            if (isAtScrollBottom()) {
                const height = scrollRoot().scrollHeight;
                if (bottomHeight !== null && height > bottomHeight + 40) {
                    // X appended more posts: move on now instead of idling.
                    return 'loaded';
                }
                if (bottomSince === null) {
                    bottomSince = Date.now();
                    bottomHeight = height;
                } else if (Date.now() - bottomSince >= (CONFIG.bottomConfirmMs || 2500)) {
                    return 'end';
                }
            } else if (Date.now() - start > 600) {
                // Not at the bottom and no new id yet: the step still moved us, go on.
                return 'moved';
            } else {
                bottomSince = null;
                bottomHeight = null;
            }

            await sleep(50);
        }
        return 'timeout';
    }

    async function scrollDownAndWait(targetId, ctrl) {
        const knownIds = currentTweetIds();
        const beforeY = scrollTop();
        const beforeHeight = scrollRoot().scrollHeight;

        await paceStep(ctrl);
        if (ctrl.aborted) return 'aborted';
        const held = await holdForMountedCap(ctrl);
        if (held === 'aborted') return 'aborted';
        if (held === 'capped') return 'capped';
        scrollDownStep();
        let outcome = await waitForStep(targetId, ctrl, knownIds);
        await waitForVirtualizer(ctrl);
        if (outcome === 'aborted' || outcome === 'found' || outcome === 'end' || outcome === 'timeout') {
            return outcome;
        }
        if (outcome === 'loaded') return 'progress';
        // 'moved' falls through: only counts as progress if the page really moved.

        // No new ids yet — if we still moved, keep going; otherwise retry this step.
        // Never jump to scrollHeight: that resets X's virtual timeline.
        if (scrollTop() > beforeY + 40 || scrollRoot().scrollHeight > beforeHeight + 40) {
            return 'progress';
        }
        if (isAtScrollBottom()) return 'end';
        return 'stuck';
    }

    // Wait until the timeline has rendered at least one tweet.
    async function waitForContentToSettle(ctrl, maxWaitMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (ctrl.aborted) return;
            if (document.querySelector('article[data-testid="tweet"]')) return;
            await sleep(80);
        }
    }

    function tweetDate(article) {
        const iso = getTweetTime(article);
        const date = iso ? new Date(iso) : null;
        return date && !isNaN(date) ? date : null;
    }

    function isSameDay(a, b) {
        return a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    function startOfDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function addDays(date, days) {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    }

    function isBeforeDay(date, day) {
        return startOfDay(date) < startOfDay(day);
    }

    function formatDayLabel(day) {
        const today = startOfDay(new Date());
        const target = startOfDay(day);
        const diffDays = Math.round((today - target) / 86400000);
        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        return target.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }

    // Pick the calendar day to scroll to from the current viewport. If we're already
    // sitting on that day's boundary, step back one day so repeated presses walk
    // backward through the timeline day by day.
    function getScrollTargetDay() {
        const top = getTopTweet();
        const fallback = startOfDay(new Date());
        if (!top?.time) return fallback;

        const topDay = startOfDay(new Date(top.time));
        let beforeCount = 0;
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
            const date = tweetDate(article);
            if (date && isBeforeDay(date, topDay)) beforeCount++;
        }

        if (beforeCount >= 2) return addDays(topDay, -1);
        return topDay;
    }

    // Scroll down the Olo timeline until the oldest tweet still on the target day,
    // i.e. the boundary right before the previous day's tweets begin, then center it.
    async function scrollToStartOfDay() {
        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;

        const targetDay = getScrollTargetDay();
        const dayLabel = formatDayLabel(targetDay);
        showPanel(`Auto-scrolling to the start of ${dayLabel}…`);
        allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 5000);

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            // Start from the currently visible tweet — don't jump back to the top.
            await waitForContentToSettle(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            let deepestTargetTime = null; // earliest target-day time reached so far (for progress)
            let endSteps = 0;
            let deepestTargetId = null;
            let pastBoundaryVotes = 0;

            for (let attempt = 1; attempt <= CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
                let oldestTargetEl = null;
                let oldestTargetTime = null;
                const visible = [];

                for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
                    const date = tweetDate(article);
                    if (!date) continue;
                    const rect = article.getBoundingClientRect();
                    if (rect.bottom > 0 && rect.top < window.innerHeight) {
                        visible.push({ article, date, top: rect.top });
                    }
                    if (isSameDay(date, targetDay)) {
                        if (!oldestTargetTime || date < oldestTargetTime) {
                            oldestTargetTime = date;
                            oldestTargetEl = article;
                        }
                    }
                }

                const foundEarlierTarget = !!(oldestTargetTime &&
                    (!deepestTargetTime || oldestTargetTime < deepestTargetTime));
                if (foundEarlierTarget) {
                    deepestTargetTime = oldestTargetTime;
                    deepestTargetId = extractTweetId(oldestTargetEl);
                    pastBoundaryVotes = 0;
                }

                // Day boundary = the bottom of the viewport is already on the previous day.
                // Mid-feed old reposts don't count — only content we've scrolled past.
                visible.sort((a, b) => b.top - a.top);
                const bottomVisible = visible.slice(0, 3);
                const bottomIsPrevDay = bottomVisible.length >= 2 &&
                    bottomVisible.every(v => isBeforeDay(v.date, targetDay));
                if (bottomIsPrevDay && !foundEarlierTarget) pastBoundaryVotes++;

                if (pastBoundaryVotes >= 2 && deepestTargetId) {
                    let landEl = oldestTargetEl || findTweetById(deepestTargetId);
                    for (let nudge = 0; !landEl && nudge < 8; nudge++) {
                        window.scrollBy(0, -Math.round(window.innerHeight * 0.7));
                        await sleep(250);
                        landEl = findTweetById(deepestTargetId);
                        if (!landEl) {
                            let best = null, bestTime = null;
                            for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
                                const date = tweetDate(article);
                                if (!date || !isSameDay(date, targetDay)) continue;
                                if (!bestTime || date < bestTime) {
                                    bestTime = date;
                                    best = article;
                                }
                            }
                            landEl = best;
                        }
                    }
                    if (landEl) {
                        landEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight(landEl);
                        const landTime = tweetDate(landEl) || deepestTargetTime;
                        return finishPanel(`Reached the start of ${dayLabel} (${formatTweetTime(landTime)})`);
                    }
                    return finishPanel(`No tweets from ${dayLabel}`);
                }

                updatePanel(deepestTargetTime
                    ? `Auto-scrolling to the start of ${dayLabel}… now at ${formatTweetTime(deepestTargetTime)}`
                    : `Auto-scrolling to the start of ${dayLabel}…`);

                const outcome = await scrollDownAndWait(null, ctrl);
                if (outcome === 'aborted') break;

                // Soft end/timeout: X may still be loading — retry before accepting boundary.
                if (outcome === 'end' || outcome === 'timeout') {
                    endSteps++;
                    if (endSteps < CONFIG.endConfirmAttempts) {
                        updatePanel(
                            `Still loading… retry ${endSteps}/${CONFIG.endConfirmAttempts} toward start of ${dayLabel}`
                        );
                        await sleep(CONFIG.endRetryDelayMs);
                        scrollDownStep();
                        continue;
                    }
                    const landEl = oldestTargetEl ||
                        (deepestTargetId ? findTweetById(deepestTargetId) : null);
                    if (landEl) {
                        landEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight(landEl);
                        const landTime = oldestTargetTime || deepestTargetTime;
                        return finishPanel(`Reached the oldest loaded tweet from ${dayLabel} (${formatTweetTime(landTime)})`);
                    }
                    return finishPanel(`No tweets from ${dayLabel}`);
                }
                endSteps = 0;
            }

            finishPanel(ctrl.aborted ? 'Stopped' : `Start of ${dayLabel} not found`);
        } finally {
            restoring = false;
            if (currentAbort === ctrl) currentAbort = null;
        }
    }

    async function waitForTimeline(maxWaitMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (!isTimelinePage()) return false;
            if (document.querySelector('article[data-testid="tweet"]') || getNavigationTabs().length) {
                return true;
            }
            await sleep(400);
        }
        return false;
    }

    // ============ UI: SEARCH PANEL + STOP BUTTON ============

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position: fixed;
            bottom: ${window.innerWidth <= 500 ? '80px' : '24px'};
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            align-items: center;
            gap: 12px;
            box-sizing: border-box;
            width: max-content;
            max-width: calc(100vw - 24px);
            padding: 10px 12px 10px 16px;
            border-radius: 14px;
            background: #15202b;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.35;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            z-index: 100000;
        `;

        const info = document.createElement('span');
        info.id = PANEL_INFO_ID;
        info.style.cssText = 'flex: 1; min-width: 0; overflow-wrap: anywhere;';

        const stop = document.createElement('button');
        stop.type = 'button';
        stop.textContent = 'Stop';
        stop.style.cssText = `
            flex: none;
            border: none;
            border-radius: 9999px;
            background: #f4212e;
            color: #fff;
            font: inherit;
            font-weight: 600;
            padding: 6px 14px;
            cursor: pointer;
        `;
        stop.addEventListener('click', abortRestore);

        panel.appendChild(info);
        panel.appendChild(stop);
        return panel;
    }

    function showPanel(text) {
        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = buildPanel();
            (document.body || document.documentElement).appendChild(panel);
        }
        updatePanel(text);
    }

    function updatePanel(text) {
        const info = document.getElementById(PANEL_INFO_ID);
        if (info) info.textContent = text;
    }

    // Show a final status for a moment, then remove the panel.
    // Always ensures a panel exists so the message is never lost.
    function finishPanel(text) {
        showPanel(text);
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const stop = panel.querySelector('button');
        if (stop) stop.remove();
        setTimeout(() => {
            const y0 = TPS_DEBUG_SCROLL ? scrollTop() : 0;
            const p = document.getElementById(PANEL_ID);
            if (p) p.remove();
            if (TPS_DEBUG_SCROLL) {
                scrollLog('idle: panel-remove', 'y=', Math.round(y0), '→', Math.round(scrollTop()));
            }
        }, 8000);
    }

    // ============ UI: "START OF TODAY" BUTTON ============

    function createButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        if (!document.body) return false;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = '🌅';
        btn.title = 'Scroll to the start of this day (press again for the previous day)';
        btn.style.cssText = `
            position: fixed;
            bottom: ${window.innerWidth <= 500 ? '150px' : '96px'};
            right: 16px;
            width: 46px;
            height: 46px;
            border: none;
            border-radius: 50%;
            background: #1d9bf0;
            color: #fff;
            font-size: 22px;
            cursor: pointer;
            z-index: 99999;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        btn.addEventListener('click', () => { scrollToStartOfDay(); });
        document.body.appendChild(btn);
        return true;
    }

    function ensureButton() {
        if (createButton()) return;
        const observer = new MutationObserver(() => {
            if (createButton()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 30000);
    }

    // ============ INIT ============

    let started = false;
    let lastSeenPath = null;
    let restoreCooldownUntil = 0;

    function setupListeners() {
        // Reduce browser scroll-anchoring jumps when X prepends tweets above the viewport.
        try {
            const style = document.createElement('style');
            style.id = 'tps-overflow-anchor-off';
            style.textContent = [
                'html, body, html body, #react-root,',
                '[data-testid="primaryColumn"], [data-testid="primaryColumn"] *',
                '{ overflow-anchor: none !important; }'
            ].join(' ');
            (document.head || document.documentElement).appendChild(style);
        } catch (_) { /* ignore */ }

        window.addEventListener('beforeunload', () => {
            if (restoring) { abortRestore(); return; }
            savePosition();
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) return;
            if (restoring) { abortRestore(); return; }
            savePosition();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') abortRestore();
            // Arrow/Page/Home/End/Space — treat as intentional scroll.
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
                noteUserScroll();
            }
        });

        // Touch/wheel/pointer mark real user scrolling; plain "scroll" also fires for X yanks.
        window.addEventListener('wheel', noteUserScroll, { passive: true });
        window.addEventListener('touchstart', function () {
            touchActive = true;
            noteUserGesture();
        }, { passive: true });
        window.addEventListener('touchmove', noteUserScroll, { passive: true });
        window.addEventListener('touchend', function () { touchActive = false; }, { passive: true });
        window.addEventListener('touchcancel', function () { touchActive = false; }, { passive: true });
        // Taps on "Show new posts" (etc.) count as intentional jump-to-top.
        window.addEventListener('pointerdown', noteUserGesture, { passive: true });
        window.addEventListener('scroll', onTimelineScroll, { passive: true });
        applyDebugNoAnchorCss();
        if (TPS_DEBUG_SCROLL) scrollLog('debug on', 'noanchor=', TPS_DEBUG_NOANCHOR);

        // X is an SPA — document load only happens once, so watch History API navigations.
        const notify = () => onPathChange();
        window.addEventListener('popstate', notify);
        const wrap = (fn) => function (...args) {
            const ret = fn.apply(this, args);
            notify();
            return ret;
        };
        history.pushState = wrap(history.pushState.bind(history));
        history.replaceState = wrap(history.replaceState.bind(history));
    }

    async function switchToTargetTabOnly() {
        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;
        showPanel(`Switching to "${CONFIG.targetTab}" tab…`);
        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            finishPanel(switched
                ? `On "${CONFIG.targetTab}"`
                : `Tab "${CONFIG.targetTab}" not found`);
        } finally {
            restoring = false;
            if (currentAbort === ctrl) currentAbort = null;
        }
    }

    async function maybeAutoRestore() {
        if (!CONFIG.autoRestore || restoring) return;
        if (!isTimelinePage()) return;
        if (Date.now() < restoreCooldownUntil) return;

        restoreCooldownUntil = Date.now() + 2000;
        const ready = await waitForTimeline();
        if (!ready || !isTimelinePage()) return;
        if (restoring) return;

        const saved = readSavedPosition();
        if (saved) {
            await restore(saved);
        } else {
            // No pin yet — still open the configured timeline tab.
            await switchToTargetTabOnly();
        }
    }

    function onPathChange() {
        const path = currentPath();
        if (path === lastSeenPath) return;

        const prev = lastSeenPath;
        if (restoring) abortRestore();
        else if (prev && isTimelinePath(prev)) savePosition();

        lastSeenPath = path;

        // Returning to a timeline via client-side nav should restore again.
        if (isTimelinePath(path) && prev && prev !== path) {
            maybeAutoRestore();
        }
    }

    // v3.42: tell the user how loading newer posts above a deep jump ended.
    function watchFillState() {
        let last = null;
        const check = () => {
            let st = null;
            try { st = document.documentElement.getAttribute('data-tps-fill'); } catch (_) { return; }
            if (st === last) return;
            last = st;
            if (restoring) return;
            if (st === 'now') finishPanel('Caught up: newer posts loaded without gaps [fill:now]');
            else if (st === 'cap' || st === 'gave-up') {
                finishPanel('Stopped filling newer posts [fill:' + st + '] — X may skip some; ' +
                    'tap the "' + CONFIG.targetTab + '" tab to reload from the top.');
            }
        };
        try {
            new MutationObserver(check).observe(document.documentElement,
                { attributes: true, attributeFilter: ['data-tps-fill'] });
        } catch (_) { /* ignore */ }
    }

    async function start() {
        if (started) return;
        started = true;

        log('started on', location.href);
        lastSeenPath = currentPath();
        setupListeners();
        ensureButton();
        watchFillState();
        setInterval(savePosition, CONFIG.saveIntervalMs);
        setInterval(fillKickTick, FILL_TICK_MS);

        await maybeAutoRestore();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
