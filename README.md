# Twitter/X Position Saver

Remembers where you stopped scrolling on your custom **"Olo"** X timeline and jumps back there on your next visit. Never lose your place again.

## How it works

While you browse the **Olo** tab, the script keeps saving the topmost visible tweet. The next time you open X, it waits for the timeline to load, **switches to the Olo tab and confirms it is active**, then scrolls down until it finds that tweet and centers it on screen. Between scroll steps it **waits for each batch of tweets to finish loading** (rather than a fixed delay), so nothing gets skipped on a slow connection.

During the search a small panel appears at the bottom showing the **timestamp of the tweet it is looking for**, together with a **Stop scrolling** button that interrupts the search at any time (pressing **Escape** does the same).

> The tab name is configurable via `CONFIG.targetTab` (default `"Olo"`). Auto-restore only runs on that tab.

## Install

### Desktop (Tampermonkey / Violentmonkey / Greasemonkey)

1. Install a userscript manager (e.g. [Tampermonkey](https://www.tampermonkey.net/)).
2. Open [`twitter-position-saver.user.js`](twitter-position-saver.user.js), click **Raw**, and confirm the install.

### Gear browser (iOS)

X's Content Security Policy blocks userscripts on iOS, so use the Web Extension instead.

**Important:** use the raw GitHub URL below. The `releases/latest/download/...` link redirects, and Gear's updater often saves an empty file — that shows up as `ZIPFoundation.Archive.ArchiveError 13`.

1. In Safari/Files, download:
   [`twitter-position-saver-gear.xpi`](https://raw.githubusercontent.com/olokkm/twitter-position-saver/main/twitter-position-saver-gear.xpi)
2. In Gear: **Settings → Web Extensions → Import** and select the XPI.
3. To update: delete the old extension (or import again over it) using the **same raw link**.
4. If content scripts don't run, open the extension's settings and **allow access to x.com**, then reload the page.

Every push to `main` publishes a new GitHub Release and refreshes the raw XPI on `main`.

## Configuration

Adjust the values at the top of the script:

```javascript
const CONFIG = {
    targetTab: 'Olo',         // auto-scroll only works on this timeline tab
    maxAgeMinutes: 180,       // ignore a saved position older than this
    saveIntervalMs: 2000,     // how often the current position is stored
    stepMaxWaitMs: 8000,      // hard cap waiting for one scroll step to load
    maxScrollAttempts: 150,   // give up searching after this many scroll steps
    autoRestore: true         // jump back automatically when the timeline loads
};
```

## Development

The Gear Web Extension is generated from the userscript, so you only edit one file (`twitter-position-saver.user.js`).

```bash
bash scripts/build-gear-xpi.sh
```

This regenerates `gear-extension/content.js` (userscript with the `GM_*` storage swapped for `localStorage`), syncs `gear-extension/manifest.json` version from the userscript `@version`, and packages `twitter-position-saver-gear.xpi`.

Pushes to `main` run `.github/workflows/release.yml`: bump patch version → build XPI → commit the XPI to `main` (for the raw install link) → tag + GitHub Release.

## Compatibility

- Works on both `x.com` and `twitter.com`
- Desktop: any userscript manager
- iOS: Gear browser Web Extension (tested under iOS Safari emulation)

## License

MIT License – see [LICENSE](LICENSE) for details.
