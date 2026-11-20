# Video Controls for Instagram

A Chromium extension (Chrome, Edge, Brave, Arc…) that gives every video on instagram.com real video
controls, and downloads videos and images in the best quality Instagram has.

## Features

**Controls on every video**: Reels, feed posts, post modals and Stories

- Progress bar with buffered range and hover time preview; click or drag to seek
- Play/pause, current and total time, frame stepping
- Playback speed 0.25×–3×, remembered across all videos
- Mute and volume (scroll over the speaker to adjust), kept in sync with Instagram's own audio button
- Picture-in-picture and fullscreen; in fullscreen, clicking the video plays and pauses it
- One end-of-video button. On reels pages it cycles **loop → play next reel → stop**, and the choice is
  remembered. Elsewhere it toggles loop / stop for that video.
- The bar auto-hides after 2 seconds, optionally leaving a thin progress line
- Grid previews (Explore, profiles) are left alone

**Stories**: the controls are a small pill on the story's right edge (a short progress bar and play/pause)
that expands on hover, so Instagram's header and reply box stay clear. ←/→ keep switching stories; the
pill has −5s / +5s buttons for seeking.

**Downloads**: the video download button opens a menu:

- **Video with audio**: the single MP4 Instagram offers (often 720p)
- **Best quality, merged**: the top video stream (often 1080p) plus audio, combined into one MP4 in the
  browser. No re-encoding, so it's quick once both are downloaded
- **Best quality, separate files**: the same two streams as two files
- **Current frame**: a PNG of the frame on screen

Best-quality streams are often VP9, so those files may only open in a web browser; the menu says so when
that's the case. Post and story images get a download button on hover that saves the largest stored
size. Carousels download the slide on screen.

## Keyboard shortcuts

Shortcuts act on the video under the mouse, or else the most visible one, and are ignored while typing.

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> / <kbd>K</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek back / forward (step set in the popup, default 5s). On stories they switch stories as usual |
| <kbd>J</kbd> / <kbd>L</kbd> | Seek ±10s |
| <kbd>0</kbd>–<kbd>9</kbd> | Jump to 0–90% |
| <kbd>&lt;</kbd> / <kbd>&gt;</kbd> | Slower / faster |
| <kbd>,</kbd> / <kbd>.</kbd> | Previous / next frame (pauses) |
| <kbd>M</kbd> | Mute |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume (while hovering a video) |
| <kbd>F</kbd> | Fullscreen |
| <kbd>P</kbd> | Picture-in-picture |
| <kbd>R</kbd> | At end: loop → play next reel → stop (loop ↔ stop outside reels pages) |
| <kbd>D</kbd> | Download the video (single MP4 with audio) |
| <kbd>S</kbd> | Save the current frame as PNG |

## Settings

The toolbar popup turns the extension on or off and sets the playback speed, arrow-key seek step, what
happens when a reel ends, keyboard shortcuts and the idle progress line. Changes apply immediately in open
tabs.

## Privacy

The extension collects nothing and talks to no server of its own. It only runs on instagram.com, where it
reads media data from Instagram's own web API with your existing session, and saves files you ask for to
your downloads folder. Settings are stored with `chrome.storage.sync`. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)

## Development

```sh
npm install
npm run dev      # Vite with hot reload; load dist/ once as below
npm run build    # type-check and build into dist/
npm run package  # build and zip dist/ for the Chrome Web Store
```

Load the extension at `chrome://extensions` (or `brave://extensions`): enable **Developer mode**, click
**Load unpacked**, and select `dist/`. After rebuilding, click the reload arrow on the extension's card.

`npm run icons` regenerates the PNG icons in `public/icons/`.

### How it works

- `src/content/index.ts` finds `<video>` elements with a `MutationObserver` (Instagram is a single-page
  app), creates one `VideoController` per video, and runs one `requestAnimationFrame` loop for on-screen
  videos only.
- `src/content/controller.ts` renders the controls in a closed Shadow DOM overlay attached to `<body>` and
  positioned over the video, so Instagram's stacking contexts can't cover it. Clicks on it never reach
  Instagram (no accidental pauses, story skips or navigation); wheel events are passed on to Instagram's
  scroll container. The overlay hides when a dialog or fixed layer covers the video.
- Instagram fights some settings: it resets `playbackRate` when it swaps sources, re-applies its mute
  state on play/pause, and loops reels in JS. The controller re-applies the user's choices.
- `src/content/page.ts` knows Instagram's page types, and spots grid tiles (another post beside it on the
  same row).
- `src/content/media.ts` finds the original files. The page only has streamed video (blob: URLs) and
  screen-sized images, so it asks Instagram's media API for the post's stored versions. Stories opened
  directly don't have the item id in the URL; their reel is read from the page's embedded data or the
  `reels_media` API and the item on screen is matched by id, image file or video length.
- `src/content/mux.ts` merges the DASH video and audio streams (fragmented MP4s) by building one `moov`
  with both tracks and copying the `moof`/`mdat` fragments unchanged, interleaved by time.
- `src/background.ts` saves CDN files with `chrome.downloads`, because the CDN is cross-origin. Files made
  in the page (merged video, frames) are saved with a same-origin blob link.

### Debugging

Run this in the DevTools console on instagram.com, then reload:

```js
localStorage.setItem('ivc-debug', '1')
```

The console then logs `[ivc]` lines: why controls are hidden and what covers them, which Instagram buttons
were clicked, mute changes that were reverted, and each step of a media lookup. Turn it off with
`localStorage.removeItem('ivc-debug')`.

## Releasing

1. Bump `version` in `package.json` (the manifest takes it from there).
2. `npm run package` and upload the zip from the project root to the Chrome Web Store dashboard.
3. Permissions to justify in the listing: `storage` (settings), `downloads` (saving media), and access to
   `www.instagram.com` (the controls and downloads).
