// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.18
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

(function() {
    'use strict';

    try {
        if (typeof unsafeWindow !== 'undefined') tpsInstallPageScrollGuard(unsafeWindow);
    } catch (_) { /* ignore */ }
    try {
        tpsInstallPageScrollGuard(window);
    } catch (_) { /* ignore */ }

    const CONFIG = {
        targetTab: 'Olo',         // auto-scroll only works on this timeline tab
        saveIntervalMs: 2000,     // how often the current position is stored
        stepMaxWaitMs: 8000,      // hard cap waiting for one scroll step to load
        maxScrollAttempts: 150,   // give up searching after this many scroll steps
        // Soft "end" = bottom of *loaded* content while X may still fetch more.
        bottomConfirmMs: 2500,
        endConfirmAttempts: 5,
        endRetryDelayMs: 1500,
        stuckConfirmAttempts: 5,
        historyMaxEntries: 15,    // recent session moments kept in the submenu
        historyDedupeMs: 45000,   // skip duplicate pin of same tweet within this window
        autoRestore: true         // jump back automatically when the timeline loads
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
    const KEY_TIMESTAMP = 'timestamp';
    const KEY_PATH = 'path';
    const KEY_HISTORY = 'session_history';

    const PANEL_ID = 'timeline-saver-panel';
    const PANEL_INFO_ID = 'timeline-saver-info';
    const BUTTON_ID = 'timeline-saver-history-button';
    const MENU_ID = 'timeline-saver-history-menu';

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
                best = { id, time: getTweetTime(article) };
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
        // Snapshot the place we were before X yanked to top (new posts loaded).
        pushHistoryFromStable('yank');
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

    function capturePosition(extra) {
        const top = getTopTweet();
        if (!top) return null;
        return Object.assign({
            tweetId: top.id,
            tweetTime: top.time,
            timestamp: Date.now(),
            path: currentPath()
        }, extra || {});
    }

    function readHistory() {
        const raw = gmGet(KEY_HISTORY);
        if (!raw) return [];
        try {
            const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function writeHistory(list) {
        gmSet(KEY_HISTORY, list);
    }

    function pushHistoryEntry(entry) {
        if (!entry || !entry.tweetId) return;
        const max = CONFIG.historyMaxEntries || 15;
        const dedupeMs = CONFIG.historyDedupeMs || 45000;
        let list = readHistory();
        const head = list[0];
        if (head && head.tweetId === entry.tweetId &&
            Math.abs((entry.timestamp || 0) - (head.timestamp || 0)) < dedupeMs) {
            // Refresh reason/time on the newest duplicate instead of stacking.
            list[0] = Object.assign({}, head, entry);
        } else {
            list.unshift(entry);
        }
        if (list.length > max) list = list.slice(0, max);
        writeHistory(list);
        refreshHistoryMenuIfOpen();
        log('History+', entry.reason, entry.tweetId);
    }

    function pushHistoryFromStable(reason) {
        if (!lastStableTweetId) return;
        let tweetTime = null;
        const el = findTweetById(lastStableTweetId);
        if (el) tweetTime = getTweetTime(el);
        pushHistoryEntry({
            tweetId: lastStableTweetId,
            tweetTime,
            timestamp: Date.now(),
            path: currentPath(),
            reason: reason || 'yank'
        });
    }

    function pushHistorySession(reason) {
        if (restoring) return;
        if (!isTimelinePage() || !isOnTargetTab()) return;
        const snap = capturePosition({ reason: reason || 'session' });
        if (!snap) return;
        pushHistoryEntry(snap);
    }

    function savePosition(opts) {
        if (restoring || suppressSaves) return;
        if (!isTimelinePage() || !isOnTargetTab()) return;

        const snap = capturePosition();
        if (!snap) return;

        gmSet(KEY_TWEET_ID, snap.tweetId);
        gmSet(KEY_TWEET_TIME, snap.tweetTime);
        gmSet(KEY_TIMESTAMP, snap.timestamp);
        gmSet(KEY_PATH, snap.path);
        log('Saved', snap.tweetId, snap.tweetTime);

        if (opts && opts.history) {
            pushHistoryEntry(Object.assign({}, snap, { reason: opts.history }));
        }
    }

    function readSavedPosition() {
        const id = gmGet(KEY_TWEET_ID);
        const timestamp = gmGet(KEY_TIMESTAMP);
        if (!id || !timestamp) return null;
        return {
            tweetId: id,
            tweetTime: gmGet(KEY_TWEET_TIME),
            timestamp,
            path: gmGet(KEY_PATH)
        };
    }

    function reasonLabel(reason) {
        switch (reason) {
            case 'blur': return 'Left app';
            case 'leave': return 'Closed / killed';
            case 'yank': return 'Feed jumped';
            case 'nav': return 'Navigated away';
            case 'manual': return 'Saved';
            default: return reason || 'Session';
        }
    }

    function formatHistoryWhen(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d)) return '';
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        return sameDay
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function highlight(tweet) {
        tweet.style.transition = 'box-shadow 0.3s ease';
        tweet.style.boxShadow = '0 0 0 3px #1d9bf0';
        setTimeout(() => { tweet.style.boxShadow = ''; }, 2000);
    }

    async function restore(saved) {
        if (!saved) return;

        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;

        const timeStr = formatTweetTime(saved.tweetTime);
        showPanel(`Switching to "${CONFIG.targetTab}" tab…`);
        allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 5000);

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            if (saved.path && saved.path !== currentPath()) {
                log('Saved position is on a different page, skipping scroll');
                return finishPanel(`On "${CONFIG.targetTab}"`);
            }

            allowProgrammaticScroll(CONFIG.stepMaxWaitMs + 5000);
            scrollRoot().scrollTop = 0;
            window.scrollTo(0, 0);
            // Wait for the fresh Olo timeline to actually render before searching.
            await waitForContentToSettle(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            let stuckSteps = 0;
            let endSteps = 0;

            for (let attempt = 1; attempt <= CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
                let tweet = findTweetById(saved.tweetId);

                if (!tweet) {
                    updatePanel(`Searching for tweet from ${timeStr} (step ${attempt})`);
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
                        continue;
                    }
                }

                // Act immediately so virtualization can't recycle the node away.
                tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight(tweet);
                log('Restored to', saved.tweetId);
                return finishPanel(`Found tweet from ${timeStr}`);
            }

            finishPanel(ctrl.aborted ? 'Stopped' : `Tweet from ${timeStr} not found`);
        } finally {
            restoring = false;
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

    // Scroll the bottom tweet into view, then nudge past it so X fetches older tweets.
    function scrollDownStep() {
        allowProgrammaticScroll(2000);
        const root = scrollRoot();
        const bottomTweet = getBottomVisibleTweet();

        if (bottomTweet) {
            bottomTweet.scrollIntoView({ block: 'end', behavior: 'auto' });
        }

        const nudge = Math.round(window.innerHeight * 0.85);
        root.scrollTop += nudge;
        window.scrollBy(0, nudge);
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
                if (bottomSince === null || height !== bottomHeight) {
                    bottomSince = Date.now();
                    bottomHeight = height;
                } else if (Date.now() - bottomSince >= (CONFIG.bottomConfirmMs || 2500)) {
                    return 'end';
                }
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

        scrollDownStep();
        let outcome = await waitForStep(targetId, ctrl, knownIds);
        if (outcome === 'aborted' || outcome === 'found' || outcome === 'end' || outcome === 'timeout') {
            return outcome;
        }
        if (outcome === 'loaded') return 'progress';

        // No new ids yet — if we still moved, keep going; otherwise recover.
        if (scrollTop() > beforeY + 40 || scrollRoot().scrollHeight > beforeHeight + 40) {
            return 'progress';
        }
        if (isAtScrollBottom()) return 'end';

        allowProgrammaticScroll(2000);
        const root = scrollRoot();
        root.scrollTop = root.scrollHeight;
        window.scrollTo(0, root.scrollHeight);
        await sleep(300);
        outcome = await waitForStep(targetId, ctrl, knownIds);
        if (outcome === 'found' || outcome === 'end' || outcome === 'timeout') return outcome;
        if (outcome === 'loaded') return 'progress';
        return (scrollTop() > beforeY + 40 || scrollRoot().scrollHeight > beforeHeight + 40)
            ? 'progress'
            : 'stuck';
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
    function finishPanel(text) {
        updatePanel(text);
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const stop = panel.querySelector('button');
        if (stop) stop.remove();
        setTimeout(() => {
            const p = document.getElementById(PANEL_ID);
            if (p) p.remove();
        }, 2500);
    }

    // ============ UI: SESSION HISTORY SUBMENU ============

    function closeHistoryMenu() {
        const menu = document.getElementById(MENU_ID);
        if (menu) menu.remove();
    }

    function refreshHistoryMenuIfOpen() {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        closeHistoryMenu();
        openHistoryMenu();
    }

    function openHistoryMenu() {
        closeHistoryMenu();
        if (!document.body) return;

        const list = readHistory();
        const menu = document.createElement('div');
        menu.id = MENU_ID;
        const bottom = window.innerWidth <= 500 ? '210px' : '156px';
        menu.style.cssText = `
            position: fixed;
            bottom: ${bottom};
            right: 16px;
            width: min(300px, calc(100vw - 32px));
            max-height: min(420px, 55vh);
            overflow: auto;
            background: #15202b;
            color: #e7e9ea;
            border: 1px solid #2f3336;
            border-radius: 14px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.55);
            z-index: 100000;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
        `;

        const head = document.createElement('div');
        head.style.cssText = 'padding: 12px 14px 8px; font-weight: 700; border-bottom: 1px solid #2f3336;';
        head.textContent = 'Recent positions';
        menu.appendChild(head);

        if (!list.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 14px; color: #71767b;';
            empty.textContent = 'No sessions yet — leave the app or wait for a feed jump.';
            menu.appendChild(empty);
        } else {
            list.forEach((entry, idx) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.style.cssText = `
                    display: block; width: 100%; text-align: left;
                    background: transparent; border: 0; border-bottom: 1px solid #2f3336;
                    color: inherit; font: inherit; padding: 10px 14px; cursor: pointer;
                `;
                const when = formatHistoryWhen(entry.timestamp);
                const tweetWhen = formatTweetTime(entry.tweetTime);
                row.innerHTML =
                    `<div style="font-weight:600">${reasonLabel(entry.reason)} · ${when}</div>` +
                    `<div style="color:#71767b;margin-top:2px">Tweet ${tweetWhen}</div>`;
                row.addEventListener('click', () => {
                    closeHistoryMenu();
                    restore({
                        tweetId: entry.tweetId,
                        tweetTime: entry.tweetTime,
                        timestamp: entry.timestamp || Date.now(),
                        path: entry.path
                    });
                });
                row.addEventListener('pointerenter', () => { row.style.background = 'rgba(239,243,244,0.08)'; });
                row.addEventListener('pointerleave', () => { row.style.background = 'transparent'; });
                menu.appendChild(row);
            });
        }

        document.body.appendChild(menu);
    }

    function toggleHistoryMenu() {
        if (document.getElementById(MENU_ID)) closeHistoryMenu();
        else openHistoryMenu();
    }

    function createButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        if (!document.body) return false;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = '⏱';
        btn.title = 'Recent timeline positions';
        btn.setAttribute('aria-label', 'Recent timeline positions');
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
            font-size: 20px;
            cursor: pointer;
            z-index: 99999;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleHistoryMenu();
        });
        document.body.appendChild(btn);

        if (!window.__tpsHistoryMenuDocClick) {
            window.__tpsHistoryMenuDocClick = true;
            document.addEventListener('click', (e) => {
                const menu = document.getElementById(MENU_ID);
                const button = document.getElementById(BUTTON_ID);
                if (!menu) return;
                if (menu.contains(e.target) || (button && button.contains(e.target))) return;
                closeHistoryMenu();
            });
        }
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
            savePosition({ history: 'leave' });
        });
        window.addEventListener('pagehide', () => {
            if (restoring) { abortRestore(); return; }
            savePosition({ history: 'leave' });
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) return;
            if (restoring) { abortRestore(); return; }
            savePosition({ history: 'blur' });
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') abortRestore();
            // Arrow/Page/Home/End/Space — treat as intentional scroll.
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
                noteUserGesture();
            }
        });

        // Touch/wheel/pointer mark real user scrolling; plain "scroll" also fires for X yanks.
        window.addEventListener('wheel', noteUserGesture, { passive: true });
        window.addEventListener('touchstart', noteUserGesture, { passive: true });
        window.addEventListener('touchmove', noteUserGesture, { passive: true });
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
        else if (prev && isTimelinePath(prev)) savePosition({ history: 'nav' });

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
