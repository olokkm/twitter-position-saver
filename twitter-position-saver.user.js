// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.8
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

            let stuckSteps = 0;

            for (let attempt = 1; attempt <= CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
                let tweet = findTweetById(saved.tweetId);

                if (!tweet) {
                    updatePanel(`Searching for tweet from ${timeStr} (step ${attempt})`);

                    const outcome = await scrollDownAndWait(saved.tweetId, ctrl);
                    if (outcome === 'aborted') break;
                    if (outcome === 'end') break;

                    tweet = findTweetById(saved.tweetId);
                    if (!tweet) {
                        if (outcome === 'stuck') {
                            if (++stuckSteps >= 3) break;
                        } else {
                            stuckSteps = 0;
                        }
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
                } else if (Date.now() - bottomSince >= 1500) {
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
        if (outcome === 'aborted' || outcome === 'found' || outcome === 'end') return outcome;
        if (outcome === 'loaded') return 'progress';

        // Timeout with no new ids — if we still moved, keep going; otherwise recover.
        if (scrollTop() > beforeY + 40 || scrollRoot().scrollHeight > beforeHeight + 40) {
            return 'progress';
        }
        if (isAtScrollBottom()) return 'end';

        const root = scrollRoot();
        root.scrollTop = root.scrollHeight;
        window.scrollTo(0, root.scrollHeight);
        await sleep(300);
        outcome = await waitForStep(targetId, ctrl, knownIds);
        if (outcome === 'found' || outcome === 'end') return outcome;
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

        try {
            const switched = await ensureTargetTab(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');
            if (!switched) return finishPanel(`Tab "${CONFIG.targetTab}" not found`);

            // Start from the currently visible tweet — don't jump back to the top.
            await waitForContentToSettle(ctrl);
            if (ctrl.aborted) return finishPanel('Stopped');

            let deepestTargetTime = null; // earliest target-day time reached so far (for progress)
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

                // Reached the end of the feed without crossing into the previous day.
                if (outcome === 'end') {
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

    async function maybeAutoRestore() {
        if (!CONFIG.autoRestore || restoring) return;
        if (!isTimelinePage()) return;
        if (Date.now() < restoreCooldownUntil) return;

        const saved = readSavedPosition();
        if (!saved) return;
        if (saved.path && saved.path !== currentPath()) return;

        restoreCooldownUntil = Date.now() + 2000;
        const ready = await waitForTimeline();
        if (!ready || !isTimelinePage()) return;
        if (saved.path && saved.path !== currentPath()) return;
        if (restoring) return;

        await restore(saved);
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
