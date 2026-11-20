import css from './styles.css?inline';
import { iconButton, setDownloadState } from './ui';
import { bestImage, findMediaRef, largestFromSrcset, resolveMedia, startDownload } from './media';
import { isGridTile, isStoriesPage } from './page';

const HOST_TAG = 'ivc-image-download';
const MIN_SIZE = 150;
const BUTTON_SIZE = 36;
const INSET = 10;

/**
 * A download button on the post or story image under the mouse. It saves the largest version
 * Instagram has of that image, not the screen-sized one the page shows.
 */
export function installImageDownloads(signal: AbortSignal): void {
  const host = document.createElement(HOST_TAG);
  host.style.cssText = `position:fixed;left:0;top:0;width:${BUTTON_SIZE}px;height:${BUTTON_SIZE}px;z-index:2147483000;display:none;`;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const button = iconButton('download', 'Download image', 'image-download');
  root.append(style, button);
  document.body.append(host);

  let current: HTMLImageElement | null = null;
  let rafId = 0;

  const hide = () => {
    current = null;
    host.style.display = 'none';
    cancelAnimationFrame(rafId);
    rafId = 0;
  };

  // Follows the image while it's shown (scrolling, carousel slides moving).
  const place = () => {
    rafId = 0;
    if (!current?.isConnected) return hide();
    const r = current.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE || r.bottom < BUTTON_SIZE || r.top > window.innerHeight - BUTTON_SIZE) return hide();
    // Stories keep their own buttons at the top right; use the middle of the right edge there.
    const top = isStoriesPage() ? r.top + r.height / 2 - BUTTON_SIZE / 2 : Math.max(r.top, 0) + INSET;
    host.style.left = `${r.right - BUTTON_SIZE - INSET}px`;
    host.style.top = `${top}px`;
    host.style.display = 'block';
    rafId = requestAnimationFrame(place);
  };

  window.addEventListener('mousemove', (e) => {
    const hit = imageAt(e.clientX, e.clientY);
    if (hit === 'button') return;
    if (hit !== current) setDownloadState(button, 'idle');
    if (!hit) return hide();
    current = hit;
    if (!rafId) place();
  }, { capture: true, passive: true, signal });

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const) {
    button.addEventListener(type, (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, { signal });
  }
  button.addEventListener('click', async () => {
    const img = current;
    if (!img || button.classList.contains('busy')) return;
    setDownloadState(button, 'busy');
    const ref = findMediaRef(img);
    const item = ref && (await resolveMedia(ref, { src: img.currentSrc || img.src }));
    const file = (item && bestImage(item, img.currentSrc || img.src)) ?? largestFromSrcset(img);
    const ok = !!file && (await startDownload(file));
    setDownloadState(button, ok ? 'done' : 'failed');
    setTimeout(() => setDownloadState(button, 'idle'), ok ? 1500 : 2500);
  }, { signal });

  signal.addEventListener('abort', () => {
    hide();
    host.remove();
  });
}

/** The downloadable image under the point, 'button' when over our own button, or null. */
function imageAt(x: number, y: number): HTMLImageElement | 'button' | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.localName === HOST_TAG) return 'button';
    // Videos have their own controls (with a download button); their poster images don't count.
    if (el.localName === 'ivc-overlay' || el instanceof HTMLVideoElement) return null;
    if (el instanceof HTMLImageElement) return isPostImage(el) ? el : null;
  }
  return null;
}

function isPostImage(img: HTMLImageElement): boolean {
  const r = img.getBoundingClientRect();
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
  if (!/cdninstagram\.com|fbcdn\.net/.test(img.currentSrc || img.src)) return false;
  if (isGridTile(img, r)) return false;
  // A thumbnail shown in place of a video that hasn't started yet.
  const box = img.parentElement?.parentElement;
  return !box?.querySelector('video');
}
