# Twitter/X Position Saver

Remembers where you stopped scrolling on your custom **"Olo"** X timeline and jumps back there on your next visit. Never lose your place again.

## How it works

While you browse the **Olo** tab, the script keeps saving the topmost visible tweet. The next time you open X, it waits for the timeline to load, **switches to the Olo tab and confirms it is active**, then scrolls down until it finds that tweet and centers it on screen.

During the search a small panel appears at the bottom showing the **timestamp of the tweet it is looking for**, together with a **Stop scrolling** button that interrupts the search at any time (pressing **Escape** does the same).

> The tab name is configurable via `CONFIG.targetTab` (default `"Olo"`). Auto-restore only runs on that tab.

## Install

### Desktop (Tampermonkey / Violentmonkey / Greasemonkey)

1. Install a userscript manager (e.g. [Tampermonkey](https://www.tampermonkey.net/)).
2. Open [`twitter-position-saver.user.js`](twitter-position-saver.user.js), click **Raw**, and confirm the install.

### Gear browser (iOS)

X's Content Security Policy blocks userscripts on iOS, so use the Web Extension instead:

1. Download `twitter-position-saver-gear.xpi` from the [latest release](../../releases/latest).
2. In Gear: **Settings → Web Extensions → Import** and select the XPI.
3. If content scripts don't run, open the extension's settings and **allow access to x.com**, then reload the page.

## Configuration

Adjust the values at the top of the script:

```javascript
const CONFIG = {
    targetTab: 'Olo',         // auto-scroll only works on this timeline tab
    maxAgeMinutes: 180,       // ignore a saved position older than this
    saveIntervalMs: 2000,     // how often the current position is stored
    scrollStepDelayMs: 300,   // pause between scroll steps while searching
    maxScrollAttempts: 150,   // give up searching after this many scroll steps
    autoRestore: true         // jump back automatically when the timeline loads
};
```

## Development

The Gear Web Extension is generated from the userscript, so you only edit one file (`twitter-position-saver.user.js`).

```bash
bash scripts/build-gear-xpi.sh
```

This regenerates `gear-extension/content.js` (userscript with the `GM_*` storage swapped for `localStorage`) and packages `twitter-position-saver-gear.xpi`. Releases build and attach the XPI automatically via `.github/workflows/release.yml`.

## Compatibility

- Works on both `x.com` and `twitter.com`
- Desktop: any userscript manager
- iOS: Gear browser Web Extension (tested under iOS Safari emulation)

## License

MIT License – see [LICENSE](LICENSE) for details.
