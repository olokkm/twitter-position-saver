// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  Remembers where you stopped scrolling on the X "Olo" timeline and jumps back there on your next visit.
// @author       zaengerlein
// @license      MIT
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        targetTab: 'Olo',         // auto-scroll only works on this timeline tab
        maxAgeMinutes: 180,       // ignore a saved position older than this
        saveIntervalMs: 2000,     // how often the current position is stored
        stepMaxWaitMs: 8000,      // hard cap waiting for one scroll step to load
        maxScrollAttempts: 150,   // give up searching after this many scroll steps
        autoRestore: true         // jump back automatically when the timeline loads
    };

    const DEBUG = false;

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

    function isTimelinePage() {
        const p = currentPath();
        return p === '/' ||
            p === '/home' ||
            p === '/i/bookmarks' ||
            p.startsWith('/search') ||
            /^\/i\/lists\/\d+$/.test(p) ||
            /^\/[^/]+$/.test(p) ||
            /^\/[^/]+\/(with_replies|media|likes|highlights)$/.test(p);
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

    // Topmost tweet sitting in the upper half of the viewport.
    function getTopTweet() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
            const rect = article.getBoundingClientRect();
            if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) {
                const id = extractTweetId(article);
                if (id) return { id, time: getTweetTime(article) };
            }
        }
        return null;
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

    function abortRestore() {
        if (currentAbort) currentAbort.aborted = true;
    }

    function savePosition() {
        if (restoring) return;
        if (!isTimelinePage() || !isOnTargetTab()) return;

        const top = getTopTweet();
        if (!top) return;

        gmSet(KEY_TWEET_ID, top.id);
        gmSet(KEY_TWEET_TIME, top.time);
        gmSet(KEY_TIMESTAMP, Date.now());
        gmSet(KEY_PATH, currentPath());
        log('Saved', top.id, top.time);
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

    function highlight(tweet) {
        tweet.style.transition = 'box-shadow 0.3s ease';
        tweet.style.boxShadow = '0 0 0 3px #1d9bf0';
        setTimeout(() => { tweet.style.boxShadow = ''; }, 2000);
    }

    async function restore(saved) {
        if (!saved) return;

        const ageMinutes = (Date.now() - saved.timestamp) / 60000;
        if (ageMinutes > CONFIG.maxAgeMinutes) {
            log('Saved position too old:', ageMinutes.toFixed(1), 'min');
            return;
        }
        if (saved.path && saved.path !== currentPath()) {
            log('Saved position is on a different page, skipping');
            return;
        }

        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;

        const timeStr = formatTweetTime(saved.tweetTime);
        showPanel(`Switching to "${CONFIG.targetTab}" tab…`);

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            scrollRoot().scrollTop = 0;
            window.scrollTo(0, 0);
            // Wait for the fresh Olo timeline to actually render before searching.
            await waitForContentToSettle(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            for (let attempt = 1; attempt <= CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
                let tweet = findTweetById(saved.tweetId);

                if (!tweet) {
                    updatePanel(`Searching for tweet from ${timeStr} (step ${attempt})`);

                    const outcome = await scrollDownAndWait(saved.tweetId, ctrl);
                    if (outcome === 'aborted') break;
                    if (outcome === 'end') break;

                    tweet = findTweetById(saved.tweetId);
                    if (!tweet) continue;
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

    function documentHeight() {
        return scrollRoot().scrollHeight;
    }

    function isAtScrollBottom() {
        const root = scrollRoot();
        return root.scrollTop + window.innerHeight >= root.scrollHeight - 2;
    }

    // Lowest tweet still visible — best anchor for triggering the next batch load.
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
        const root = scrollRoot();
        const beforeY = scrollTop();
        const beforeHeight = root.scrollHeight;
        const bottomTweet = getBottomVisibleTweet();
        const bottomId = bottomTweet ? extractTweetId(bottomTweet) : null;

        if (bottomTweet) {
            bottomTweet.scrollIntoView({ block: 'end', behavior: 'auto' });
        }

        const nudge = Math.round(window.innerHeight * 0.55);
        root.scrollTop += nudge;
        window.scrollBy(0, nudge);

        return { beforeY, beforeHeight, bottomId };
    }

    function stepMadeProgress(stepBefore) {
        const root = scrollRoot();
        if (scrollTop() > stepBefore.beforeY + 40) return true;
        if (root.scrollHeight > stepBefore.beforeHeight + 40) return true;

        const bottomTweet = getBottomVisibleTweet();
        const bottomId = bottomTweet ? extractTweetId(bottomTweet) : null;
        return !!(bottomId && bottomId !== stepBefore.bottomId);
    }

    // Resolve once the target appears or the scroll step actually moved the feed.
    // Returns 'end' only at the true bottom; 'stuck' on timeout so callers can retry.
    async function waitForStep(targetId, ctrl, stepBefore) {
        const start = Date.now();
        let bottomSince = null;

        while (Date.now() - start < CONFIG.stepMaxWaitMs) {
            if (ctrl.aborted) return 'aborted';
            if (targetId && findTweetById(targetId)) return 'found';
            if (stepMadeProgress(stepBefore)) return 'progress';

            if (isAtScrollBottom()) {
                if (bottomSince === null) bottomSince = Date.now();
                else if (Date.now() - bottomSince >= 1000) return 'end';
            } else {
                bottomSince = null;
            }

            await sleep(50);
        }
        return 'stuck';
    }

    async function scrollDownAndWait(targetId, ctrl) {
        let stepBefore = scrollDownStep();
        let outcome = await waitForStep(targetId, ctrl, stepBefore);
        if (outcome !== 'stuck') return outcome;

        for (let retry = 1; retry <= 2 && !ctrl.aborted; retry++) {
            stepBefore = scrollDownStep();
            outcome = await waitForStep(targetId, ctrl, stepBefore);
            if (outcome !== 'stuck') return outcome;

            const root = scrollRoot();
            const jump = Math.round(window.innerHeight * retry);
            root.scrollTop += jump;
            window.scrollBy(0, jump);
            await sleep(300);
            outcome = await waitForStep(targetId, ctrl, stepBefore);
            if (outcome !== 'stuck') return outcome;
        }

        // Don't stall on a slow batch — let the outer loop try another step.
        return isAtScrollBottom() ? 'end' : 'progress';
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

    // Scroll down the Olo timeline until the oldest tweet still from today, i.e. the
    // boundary right before yesterday's tweets begin, then center it.
    async function scrollToStartOfDay() {
        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;
        restoring = true;

        const today = new Date();
        showPanel('Auto-scrolling to the start of today…');

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            // Start from the currently visible tweet — don't jump back to the top.
            await waitForContentToSettle(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            let deepestTodayTime = null; // earliest today time reached so far (for progress)

            for (let attempt = 1; attempt <= CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
                let beforeTodayCount = 0;
                let oldestTodayEl = null;
                let oldestTodayTime = null;

                for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
                    const date = tweetDate(article);
                    if (!date) continue;
                    if (isSameDay(date, today)) {
                        if (!oldestTodayTime || date < oldestTodayTime) {
                            oldestTodayTime = date;
                            oldestTodayEl = article;
                        }
                    } else if (date < today) {
                        beforeTodayCount++;
                    }
                }

                if (oldestTodayTime && (!deepestTodayTime || oldestTodayTime < deepestTodayTime)) {
                    deepestTodayTime = oldestTodayTime;
                }

                // Require a couple of pre-today tweets so a single old repost among today's
                // tweets doesn't trigger the boundary prematurely.
                const sawBeforeToday = beforeTodayCount >= 2;

                // Once yesterday's tweets appear, the oldest today tweet in view is the start of the day.
                if (sawBeforeToday) {
                    if (oldestTodayEl) {
                        oldestTodayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight(oldestTodayEl);
                        return finishPanel(`Reached the start of today (${formatTweetTime(oldestTodayTime)})`);
                    }
                    return finishPanel('No tweets from today');
                }

                updatePanel(deepestTodayTime
                    ? `Auto-scrolling to the start of today… now at ${formatTweetTime(deepestTodayTime)}`
                    : 'Auto-scrolling to the start of today…');

                const outcome = await scrollDownAndWait(null, ctrl);
                if (outcome === 'aborted') break;

                // Reached the end of the feed without crossing into yesterday.
                if (outcome === 'end') {
                    if (oldestTodayEl) {
                        oldestTodayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight(oldestTodayEl);
                        return finishPanel(`Reached the oldest loaded tweet from today (${formatTweetTime(oldestTodayTime)})`);
                    }
                    return finishPanel('No tweets from today');
                }
            }

            finishPanel(ctrl.aborted ? 'Stopped' : 'Start of today not found');
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

    // ============ UI: "START OF TODAY" BUTTON ============

    function createButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        if (!document.body) return false;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = '🌅';
        btn.title = 'Scroll to the start of today';
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

    function setupListeners() {
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
        });
    }

    async function start() {
        if (started) return;
        started = true;

        log('started on', location.href);
        setupListeners();
        ensureButton();

        const saved = readSavedPosition();
        const ready = await waitForTimeline();
        if (ready && CONFIG.autoRestore && saved) {
            await restore(saved);
        }

        setInterval(savePosition, CONFIG.saveIntervalMs);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
