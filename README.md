# Video Controls for Instagram

A Chromium extension (Chrome, Edge, Brave, Arc…) that adds a full video control bar to every video on
instagram.com: Reels, Stories, feed posts and post modals.

- Progress bar with buffered range, hover time preview, and click or drag to seek
- Play/pause, current/total time
- Playback speed 0.25×–3×, remembered across all videos
- Mute and volume slider (scroll over the volume to adjust)
- Loop toggle (also turns off Instagram's forced looping), frame stepping, picture-in-picture
- Fullscreen, where clicking the video plays and pauses instead of opening the post
- Auto-play next reel: on reels pages, scrolls to the next reel when the current one ends
- Keyboard shortcuts
- The bar auto-hides after 2s of inactivity, with an optional thin progress line left visible

## Install

```sh
npm install
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/` folder.

For development, `npm run dev` starts Vite with hot reload. Load `dist/` the same way once.

## Keyboard shortcuts

Shortcuts act on the video under the mouse, or else the most visible one. They're ignored while typing.

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> / <kbd>K</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek back / forward (step set in popup, default 5s) |
| <kbd>J</kbd> / <kbd>L</kbd> | Seek ±10s |
| <kbd>0</kbd>–<kbd>9</kbd> | Jump to 0–90% |
| <kbd>&lt;</kbd> / <kbd>&gt;</kbd> | Slower / faster |
| <kbd>,</kbd> / <kbd>.</kbd> | Previous / next frame (pauses) |
| <kbd>M</kbd> | Mute |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume (only while hovering a video) |
| <kbd>F</kbd> | Fullscreen |
| <kbd>P</kbd> | Picture-in-picture |
| <kbd>R</kbd> | Loop |
| <kbd>N</kbd> | Auto-play next reel |

## Settings

Click the toolbar icon to toggle the extension, pick the default speed and seek step, and turn shortcuts or
the idle progress line on or off. Changes apply immediately in open tabs.

## How it works

- `src/content/index.ts` finds `<video>` elements with a `MutationObserver` (Instagram is a single-page
  app), creates one `VideoController` per video, and runs one `requestAnimationFrame` loop for on-screen
  videos only.
- `src/content/controller.ts` renders the bar in a closed Shadow DOM overlay attached to `<body>`. The overlay
  is positioned over the video's on-screen rect, so Instagram's own overlays and stacking contexts can't
  cover it. Clicks on the bar are stopped before they reach Instagram, so they don't pause the video or
  advance a story. Wheel events are passed on to Instagram's scroll container.
- The bar hides when something unrelated covers the video, such as a modal or a fixed nav bar.
- Muting from our bar clicks Instagram's own audio button when it can find one, so Instagram's icon and its
  remembered mute state stay in sync. If Instagram changes the mute state without a click from you (e.g. on
  play or pause), the extension restores your choice.
- Instagram resets `playbackRate` when it swaps sources, so the remembered speed is re-applied on
  `loadstart`, `loadedmetadata`, `play` and `ratechange`.
- Settings live in `chrome.storage.sync` (`src/shared/settings.ts`).

## Debugging

If the bar doesn't appear somewhere, or mute or auto-next misbehave, run this in the DevTools console on
instagram.com and reload:

```js
localStorage.setItem('ivc-debug', '1')
```

The console then logs `[ivc]` messages: why a bar is hidden and which element covers it, which Instagram
button was clicked, and when Instagram's mute changes are reverted. Use `localStorage.removeItem('ivc-debug')`
to turn it off.

`npm run icons` regenerates the PNG icons in `public/icons/`.
