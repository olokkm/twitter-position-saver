# Agent guidelines

## Testing

- **Only test in mobile iOS view.** The target platform is the **Gear browser on iOS**, so all browser/CDP testing must emulate an iPhone. Do not validate on desktop viewport.
- Before testing, set up emulation via CDP:
  - `Emulation.setDeviceMetricsOverride` → `width: 390, height: 844, deviceScaleFactor: 3, mobile: true`
  - `Emulation.setUserAgentOverride` → iOS Safari UA, e.g. `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`, `platform: "iPhone"`
  - `Emulation.setTouchEmulationEnabled` → `enabled: true, maxTouchPoints: 5`
  - Then reload `https://x.com/home` so X renders its mobile layout.
- On mobile the timeline tab bar is **not** inside `[data-testid="primaryColumn"]`; tab detection relies on `scoreTablist` scoring.

## Project layout

- **`twitter-position-saver.user.js` is the single source of truth.** Edit only this file.
- `gear-extension/content.js` is **generated** from the userscript by `scripts/build-gear-extension.mjs` (it swaps the `GM_*` storage for `localStorage`). Never edit it by hand.
- `scripts/build-gear-xpi.sh` regenerates `content.js` and packages `twitter-position-saver-gear.xpi` for Gear.
- Generated artifacts (`gear-extension/content.js`, `twitter-position-saver-gear.xpi`) are git-ignored; CI builds them for releases.
- After editing the userscript, always run: `node --check twitter-position-saver.user.js && bash scripts/build-gear-xpi.sh`.

## Behavior notes

- Auto-restore only runs on the custom timeline tab named in `CONFIG.targetTab` (default `"Olo"`); it switches to that tab and confirms it is active before scrolling.
- While searching, wait for content to actually load between scroll steps (DOM height stable for `stepSettleMs`) instead of a fixed delay.
