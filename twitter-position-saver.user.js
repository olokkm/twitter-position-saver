// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.28
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

/* TPS_SCROLL_GUARD_BEGIN */
// Page-realm scroll block (Tampermonkey: unsafeWindow). Gear content scripts are
// isolated, so on Gear we rely on yank detection/restore in the main script.
function tpsInstallPageScrollGuard(globalObj) {
    'use strict';
    const g = globalObj || (typeof window !== 'undefined' ? window : null);
    if (!g || g.__tpsScrollGuardInstalled) return;
    g.__tpsScrollGuardInstalled = true;

    const USER_GRACE_MS = 900;
    const MID_FEED_Y = 280;
    const TOP_TARGET_Y = 140;
    const BIG_JUMP_PX = 350;

    let lastGestureAt = 0;
    g.__tpsAllowScrollUntil = 0;

    const markGesture = () => { lastGestureAt = Date.now(); };
    g.addEventListener('wheel', markGesture, true);
    g.addEventListener('touchstart', markGesture, true);
    g.addEventListener('touchmove', markGesture, true);
    g.addEventListener('pointerdown', markGesture, true);
    g.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            markGesture();
        }
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
        return now < g.__tpsAllowScrollUntil || now - lastGestureAt < USER_GRACE_MS;
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

    function shouldBlockJumpTo(nextY) {
        if (typeof nextY !== 'number' || !isFinite(nextY) || isAllowed()) return false;
        const cur = currentY();
        if (cur < MID_FEED_Y) return false;
        if (nextY <= TOP_TARGET_Y) return true;
        if (cur - nextY >= BIG_JUMP_PX && nextY < (g.innerHeight || 800)) return true;
        return false;
    }

    function parseScrollArgs(args) {
        if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            return { left: args[0].left, top: args[0].top, opts: args[0] };
        }
        return { left: args[0], top: args[1], opts: null };
    }

    function wrapScrollFn(orig) {
        return function (...args) {
            const { top } = parseScrollArgs(args);
            if (typeof top === 'number' && shouldBlockJumpTo(top)) return;
            return orig.apply(this, args);
        };
    }

    try {
        g.scrollTo = wrapScrollFn(g.scrollTo.bind(g));
        g.scroll = wrapScrollFn(g.scroll.bind(g));
        g.scrollBy = wrapScrollFn(g.scrollBy.bind(g));
    } catch (_) { /* ignore */ }

    try {
        const origSIV = g.Element.prototype.scrollIntoView;
        g.Element.prototype.scrollIntoView = function (...args) {
            if (!isAllowed()) {
                try {
                    const rect = this.getBoundingClientRect();
                    const targetY = currentY() + rect.top;
                    if (shouldBlockJumpTo(Math.max(0, targetY))) return;
                } catch (_) { /* fall through */ }
            }
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
                    try {
                        const doc = g.document;
                        const se = doc && (doc.scrollingElement || doc.documentElement);
                        if ((this === se || this === doc.documentElement || this === doc.body) &&
                            shouldBlockJumpTo(next)) {
                            return;
                        }
                    } catch (_) { /* fall through */ }
                    desc.set.call(this, value);
                }
            });
        } catch (_) { /* ignore */ }
    }

    try {
        patchScrollTop(g.Element.prototype);
        patchScrollTop(g.HTMLElement && g.HTMLElement.prototype);
    } catch (_) { /* ignore */ }
}
/* TPS_SCROLL_GUARD_END */

/* TPS_JUMP_HOOK_BEGIN */
// Page-realm fetch/XHR rewrite (Tampermonkey: unsafeWindow; Gear: injected <script>).
// 1) Pending data-tps-jump → first ListLatestTweetsTimeline without cursor gets a
//    Bottom cursor (type 2) so the list opens near the saved tweet.
// 2) After a jump, Top cursor (type 1) requests are rewritten to Bottom with
//    B' = B_top + delta so scrolling up fills the gap toward "now" instead of
//    leaping to the live head of the list.
// 3) Every ListLatestTweetsTimeline response is scanned read-only for
//    displayedTweetId → sortIndex mappings (repost-aware) and published to
//    <script type="application/json" id="tps-sortmap"> for the content script.
function tpsInstallPageJumpHook(globalObj) {
    'use strict';
    const g = globalObj || (typeof window !== 'undefined' ? window : null);
    if (!g || g.__tpsJumpHookInstalled) return;
    g.__tpsJumpHookInstalled = true;

    const TWITTER_EPOCH_MS = 1288834974657n;
    const DEFAULT_FILL_DELTA = BigInt(3 * 60 * 60 * 1000) << 22n; // ~3 hours
    const TARGET_PAGE_ENTRIES = 60n;
    const SORTMAP_MAX = 600;

    // Survives for the document lifetime once a jump cursor was applied.
    let jumpSession = null; // { fillUp, pageDelta }

    // displayedTweetId → sortIndex (string). Keep max sortIndex on collision.
    const sortMap = new Map();
    const sortMapOrder = []; // insertion order for eviction

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
                if (BigInt(prev) >= BigInt(si)) return; // keep max (most recent repost)
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

    // Pure: walk TimelineAddEntries and return { sortIndexes, pairs: [[id, sortIndex], ...] }
    function extractSortMapFromListJson(json) {
        const sortIndexes = [];
        const pairs = [];
        try {
            const tl = json && json.data && json.data.list &&
                json.data.list.tweets_timeline && json.data.list.tweets_timeline.timeline;
            const instructions = tl && tl.instructions;
            if (!Array.isArray(instructions)) return { sortIndexes, pairs };

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
                    const sortIndex = ent.sortIndex != null ? String(ent.sortIndex) : null;
                    if (typeof eid !== 'string' || eid.indexOf('tweet-') !== 0 || !sortIndex) continue;
                    if (!/^\d+$/.test(sortIndex)) continue;
                    // sortIndex is a per-request ordering value anchored near "now", not
                    // a time, so it cannot be used as a cursor position. The entry's own
                    // tweet id (for a repost: the repost's id) is the real timeline position.
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
                }
            }
        } catch (_) { /* ignore */ }
        return { sortIndexes, pairs };
    }

    function noteTimelineDensity(newestId, oldestId, entryCount) {
        if (!jumpSession || entryCount < 2) return;
        try {
            const newest = BigInt(newestId);
            const oldest = BigInt(oldestId);
            if (newest <= oldest) return;
            const span = newest - oldest;
            const denom = BigInt(entryCount - 1);
            jumpSession.pageDelta = (span * TARGET_PAGE_ENTRIES) / denom;
            if (jumpSession.pageDelta <= 0n) jumpSession.pageDelta = null;
        } catch (_) { /* ignore */ }
    }

    function inspectResponseText(text) {
        if (!text) return;
        try {
            const json = JSON.parse(text);
            const extracted = extractSortMapFromListJson(json);
            for (let i = 0; i < extracted.pairs.length; i++) {
                recordSortMapping(extracted.pairs[i][0], extracted.pairs[i][1]);
            }
            if (extracted.pairs.length) publishSortMap();

            if (jumpSession && extracted.sortIndexes.length >= 2) {
                // sortIndexes are newest → oldest (strictly decreasing).
                const arr = extracted.sortIndexes;
                noteTimelineDensity(arr[0], arr[arr.length - 1], arr.length);
            }
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
            return { A, B, fillUp };
        } catch (_) {
            return null;
        }
    }

    function startJumpSession(fillUp) {
        jumpSession = {
            fillUp: fillUp !== false,
            pageDelta: null
        };
        try {
            const el = g.document.documentElement;
            el.removeAttribute('data-tps-jump');
            el.setAttribute('data-tps-jump-used', String(Date.now()));
            el.setAttribute('data-tps-jump-session', '1');
        } catch (_) { /* ignore */ }
    }

    function rewriteTopCursorToFillUp(decoded, pageDelta, nowMs) {
        if (!decoded || decoded.type !== 1) return null;
        const delta = pageDelta && pageDelta > 0n ? pageDelta : DEFAULT_FILL_DELTA;
        const nowSf = snowflakeFromMs(nowMs == null ? Date.now() : nowMs);
        const Btop = decoded.B;
        if (Btop >= nowSf) return null;
        let Bp = Btop + delta;
        if (Bp >= nowSf) return null;
        return encodeListCursor(decoded.A, Bp, 2);
    }

    function maybeRewriteUrl(urlStr) {
        try {
            if (!urlStr || typeof urlStr !== 'string') return null;
            if (urlStr.indexOf('/ListLatestTweetsTimeline') === -1) return null;
            const u = new URL(urlStr, g.location.href);
            if (u.pathname.indexOf('/ListLatestTweetsTimeline') === -1) return null;
            const varsRaw = u.searchParams.get('variables');
            if (!varsRaw) return null;
            const vars = JSON.parse(varsRaw);

            if (vars.cursor == null || vars.cursor === '') {
                const jump = readPendingJump();
                if (!jump) return null;
                vars.cursor = encodeListCursor(jump.A, jump.B, 2);
                u.searchParams.set('variables', JSON.stringify(vars));
                startJumpSession(jump.fillUp);
                return u.toString();
            }

            if (!jumpSession || !jumpSession.fillUp) return null;
            let decoded;
            try {
                decoded = decodeListCursor(String(vars.cursor));
            } catch (_) {
                return null;
            }
            const nextCursor = rewriteTopCursorToFillUp(decoded, jumpSession.pageDelta, Date.now());
            if (!nextCursor) return null;
            vars.cursor = nextCursor;
            u.searchParams.set('variables', JSON.stringify(vars));
            return u.toString();
        } catch (_) {
            return null;
        }
    }

    function isListTimelineUrl(url) {
        return typeof url === 'string' && url.indexOf('/ListLatestTweetsTimeline') !== -1;
    }

    const origFetch = g.fetch;
    if (typeof origFetch === 'function') {
        g.fetch = function (input, init) {
            let url = null;
            try {
                if (typeof input === 'string') url = input;
                else if (input && typeof input.url === 'string') url = input.url;
                if (url) {
                    const rewritten = maybeRewriteUrl(url);
                    if (rewritten) {
                        url = rewritten;
                        if (typeof input === 'string') {
                            input = rewritten;
                        } else if (typeof Request !== 'undefined' && input instanceof Request) {
                            input = new Request(rewritten, input);
                        } else {
                            input = rewritten;
                        }
                    }
                }
            } catch (_) { /* ignore */ }

            const result = origFetch.call(this, input, init);
            // Always sample ListLatestTweetsTimeline for sortmap (+ density in session).
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
        };
    }

    const XHR = g.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url) {
            try {
                this.__tpsListUrl = typeof url === 'string' ? url : null;
                if (typeof url === 'string') {
                    const rewritten = maybeRewriteUrl(url);
                    if (rewritten) {
                        arguments[1] = rewritten;
                        this.__tpsListUrl = rewritten;
                    }
                }
            } catch (_) { /* ignore */ }
            return origOpen.apply(this, arguments);
        };

        XHR.prototype.send = function () {
            try {
                if (isListTimelineUrl(this.__tpsListUrl)) {
                    const xhr = this;
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

    g.__tpsRewriteTopCursorToFillUp = rewriteTopCursorToFillUp;
    g.__tpsDecodeListCursor = decodeListCursor;
    g.__tpsEncodeListCursor = encodeListCursor;
    g.__tpsExtractSortMapFromListJson = extractSortMapFromListJson;
}
/* TPS_JUMP_HOOK_END */

// Gear (isolated world): inject page-realm hooks as a real <script> with the
// page CSP nonce. Tampermonkey uses unsafeWindow instead and skips this.
function tpsInjectPageRealmScripts() {
    'use strict';
    if (typeof document === 'undefined') return;

    const code = [
        '(' + tpsInstallPageScrollGuard.toString() + ')(window);',
        '(' + tpsInstallPageJumpHook.toString() + ')(window);'
    ].join('\n');

    function findNonce() {
        try {
            const scripts = document.querySelectorAll('script[nonce]');
            for (let i = 0; i < scripts.length; i++) {
                const n = scripts[i].nonce || scripts[i].getAttribute('nonce');
                if (n) return n;
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    function inject(nonce) {
        try {
            if (document.documentElement.getAttribute('data-tps-page-injected') === '1') return true;
            const s = document.createElement('script');
            if (nonce) {
                try { s.nonce = nonce; } catch (_) { /* ignore */ }
                try { s.setAttribute('nonce', nonce); } catch (_) { /* ignore */ }
            }
            s.textContent = code;
            const parent = document.documentElement || document.head || document.body;
            if (!parent) return false;
            parent.appendChild(s);
            s.remove();
            document.documentElement.setAttribute('data-tps-page-injected', '1');
            return true;
        } catch (_) {
            return false;
        }
    }

    function tryInject() {
        const nonce = findNonce();
        if (!nonce) return false;
        return inject(nonce);
    }

    if (tryInject()) return;

    const root = document.documentElement || document;
    const mo = new MutationObserver(() => {
        if (tryInject()) mo.disconnect();
    });
    try {
        mo.observe(root, { childList: true, subtree: true });
    } catch (_) { /* ignore */ }
    setTimeout(() => { try { mo.disconnect(); } catch (_) { /* ignore */ } }, 15000);
}


(function() {
    'use strict';

    try {
        if (typeof unsafeWindow !== 'undefined') {
            tpsInstallPageScrollGuard(unsafeWindow);
            tpsInstallPageJumpHook(unsafeWindow);
        } else {
            // Gear WebExtension: isolated world — inject into the page with CSP nonce.
            tpsInjectPageRealmScripts();
        }
    } catch (_) { /* ignore */ }
    try {
        // Best-effort local install (no-op if already installed / wrong realm).
        tpsInstallPageScrollGuard(window);
        tpsInstallPageJumpHook(window);
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
        jumpLeadMs: 60 * 60 * 1000, // ~1h of newer tweets above the pin (Olo: ~8/h measured Oct 3) so the page is scrolled, not at the top; X only requests newer posts (Top cursor) when you scroll back up to the top
        jumpAnchor: 'now',         // 'now' = snowflakeFromMs(Date.now()); 'b' = use B
        jumpFillUp: true           // rewrite Top cursors to Bottom fill-ups after a jump
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
    }

    // Arm a one-shot cursor rewrite: B|A|expiresAtMs|fillUp on <html data-tps-jump>.
    // B is based on sortId (timeline order / repost id), not the displayed status id.
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
            document.documentElement.setAttribute(
                'data-tps-jump',
                B.toString(10) + '|' + A.toString(10) + '|' + String(expires) + '|' + fillUp
            );
            log('Armed cursor jump B=', B.toString(), 'A=', A.toString());
            return true;
        } catch (e) {
            log('armCursorJump failed', e);
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

    function lookupSortId(tweetId) {
        if (!tweetId) return null;
        const mapped = readSortMap()[String(tweetId)];
        return mapped != null ? String(mapped) : null;
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
    const USER_SCROLL_GRACE_MS = 800;
    const YANK_JUMP_PX = 250;
    let lastUserGestureAt = 0;
    let lastStableScrollY = 0;
    let lastStableTweetId = null;
    let suppressSaves = false;
    let yankRestoreCooldownUntil = 0;

    function abortRestore() {
        if (currentAbort) currentAbort.aborted = true;
    }

    function noteUserGesture() {
        lastUserGestureAt = Date.now();
        if (suppressSaves) {
            suppressSaves = false;
            log('User scroll — resume saving');
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

    function undoXYank() {
        suppressSaves = true;
        if (Date.now() < yankRestoreCooldownUntil) return;
        yankRestoreCooldownUntil = Date.now() + 1000;
        log('Blocked X auto-jump; restoring position');
        allowProgrammaticScroll(1500);

        const tweet = lastStableTweetId && findTweetById(lastStableTweetId);
        if (tweet) {
            tweet.scrollIntoView({ block: 'start', behavior: 'auto' });
        } else {
            scrollRoot().scrollTop = lastStableScrollY;
            window.scrollTo(0, lastStableScrollY);
        }
    }

    function onTimelineScroll() {
        if (restoring) {
            rememberStablePosition();
            return;
        }
        if (!isTimelinePage() || !isOnTargetTab()) {
            lastStableScrollY = scrollTop();
            return;
        }

        const y = scrollTop();
        const jumpedToTop = lastStableScrollY - y > YANK_JUMP_PX && y < window.innerHeight;

        if (jumpedToTop && !userRecentlyScrolled()) {
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

        const top = getTopTweet();
        if (!top) return;

        const sortId = resolveSortIdForArticle(top.article, top.id);
        gmSet(KEY_TWEET_ID, top.id);
        gmSet(KEY_TWEET_TIME, top.time);
        gmSet(KEY_SORT_ID, sortId);
        gmSet(KEY_TIMESTAMP, Date.now());
        gmSet(KEY_PATH, currentPath());
        log('Saved', top.id, top.time, 'sort', sortId);
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
            if (earlySaved && isHomeTimelinePath(earlySaved.path || currentPath())) {
                armCursorJump(earlySaved, 20000);
            }
        }
    } catch (_) { /* ignore */ }

    function highlight(tweet) {
        tweet.style.transition = 'box-shadow 0.3s ease';
        tweet.style.boxShadow = '0 0 0 3px #1d9bf0';
        setTimeout(() => { tweet.style.boxShadow = ''; }, 2000);
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
                allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 2000);
                tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight(tweet);
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
        gmSet(KEY_RESTORE_ACTIVE, Date.now());

        if (crashes >= 3) {
            gmSet(KEY_RESTORE_ACTIVE, 0);
            gmSet(KEY_RESTORE_CRASHES, 0);
            showPanel("Search reloaded the page again — stopped so it does not loop");
            return;
        }

        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;

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

            if (wantJump) {
                updatePanel(`Jumping near tweet from ${timeStr}…`);
                let used = jumpWasUsed() || await waitForJumpUsed(ctrl, 2500);
                if (ctrl.aborted) return finishPanel('Stopped');

                // Timeline may have loaded before the hook was armed — try one
                // tab switch away and back to force a fresh ListLatestTweetsTimeline.
                if (!used) {
                    log('Jump not consumed; trying tab-switch refetch');
                    updatePanel(`Refreshing "${CONFIG.targetTab}" for jump…`);
                    armCursorJump(saved, 15000);
                    const refetched = await refetchTargetTabWithJump(saved, ctrl);
                    if (ctrl.aborted) return finishPanel('Stopped');
                    if (refetched) {
                        used = jumpWasUsed() || await waitForJumpUsed(ctrl, 2500);
                    }
                }

                if (used) {
                    // Do NOT scroll to top — wait for the jumped page to render.
                    await waitForContentToSettle(ctrl);
                    if (ctrl.aborted) return finishPanel('Stopped');
                    for (let i = 0; i < 20 && !findTweetById(saved.tweetId); i++) {
                        if (ctrl.aborted) return finishPanel('Stopped');
                        await sleep(100);
                    }
                    const landed = findTweetById(saved.tweetId);
                    if (landed) {
                        allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 2000);
                        landed.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight(landed);
                        log('Jumped to', saved.tweetId);
                        return finishPanel(`Jumped near tweet from ${timeStr}`);
                    }

                    // Limited near-jump search: UP first if target sort is newer than
                    // the newest mounted post, otherwise DOWN.
                    jumpedNear = true;
                    const nearResult = await searchNearJump(saved, ctrl, timeStr);
                    if (nearResult !== 'continue') return nearResult;
                } else {
                    log('Jump unused; falling back to scroll search from top');
                }
            }

            if (!jumpedNear) {
                allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 5000);
                scrollRoot().scrollTop = 0;
                window.scrollTo(0, 0);
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

                tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight(tweet);
                log('Restored to', saved.tweetId);
                return finishPanel(
                    jumpedNear
                        ? `Jumped near tweet from ${timeStr}`
                        : `Found tweet from ${timeStr}`
                );
            }

            if (ctrl.aborted) return finishPanel('Stopped');
            if (jumpedNear) {
                return finishPanel('Jumped near the post, but it was not on the page');
            }
            return finishPanel(`Tweet from ${timeStr} not found`);
        } finally {
            restoring = false;
            gentleRestore = false;
            gmSet(KEY_RESTORE_ACTIVE, 0);
            gmSet(KEY_RESTORE_CRASHES, 0);
            if (currentAbort === ctrl) currentAbort = null;
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
            const p = document.getElementById(PANEL_ID);
            if (p) p.remove();
        }, 3500);
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
            style.textContent = 'html, body, [data-testid="primaryColumn"] { overflow-anchor: none !important; }';
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
        window.addEventListener('touchstart', noteUserGesture, { passive: true });
        window.addEventListener('touchmove', noteUserScroll, { passive: true });
        // Taps on "Show new posts" (etc.) count as intentional jump-to-top.
        window.addEventListener('pointerdown', noteUserGesture, { passive: true });
        window.addEventListener('scroll', onTimelineScroll, { passive: true });

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

    async function start() {
        if (started) return;
        started = true;

        log('started on', location.href);
        lastSeenPath = currentPath();
        setupListeners();
        ensureButton();
        setInterval(savePosition, CONFIG.saveIntervalMs);

        await maybeAutoRestore();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
