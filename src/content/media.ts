// Finds the original, highest-resolution file behind a video or image on the page.
//
// Instagram plays videos through MediaSource (blob: URLs) and serves images sized for the viewer's
// screen, so the page itself has no full-quality file. Its media API (what instagram.com itself
// uses) lists every stored version: progressive MP4s for videos and all image sizes up to the
// original upload. When the API isn't available (e.g. logged out), the JSON embedded in the page is
// searched for the same data.

const APP_ID = '936619743392459';
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const POST_HREF = /\/(?:p|reels?)\/([\w-]+)/;

interface Version {
  url: string;
  width: number;
  height: number;
}

/** The subset of Instagram's media JSON we use. */
export interface MediaItem {
  pk?: string | number;
  id?: string;
  code?: string;
  user?: { username?: string };
  video_duration?: number;
  video_versions?: Version[];
  image_versions2?: { candidates?: Version[] };
  carousel_media?: MediaItem[];
}

export interface MediaRef {
  pk: string;
  code?: string;
}

export interface Download {
  url: string;
  filename: string;
}

/** Instagram shortcodes are the media id in base64 (with its own alphabet). */
export function shortcodeToPk(code: string): string {
  let pk = 0n;
  for (const ch of code.slice(0, 11)) pk = pk * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(ch));
  return pk.toString();
}

/** Which post, reel or story an element on the page belongs to. */
export function findMediaRef(el: Element): MediaRef | null {
  const story = location.pathname.match(/^\/stories\/[^/]+\/(\d+)/);
  if (story) return { pk: story[1] };
  const code = shortcodeNear(el) ?? postCodeFromHref(location.pathname);
  return code ? { pk: shortcodeToPk(code), code } : null;
}

function postCodeFromHref(href: string): string | null {
  const code = href.match(POST_HREF)?.[1];
  return code && code !== 'audio' ? code : null;
}

/** The post link nearest to the element: the first ancestor that links to exactly one post. */
function shortcodeNear(el: Element): string | null {
  for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 15; node = node.parentElement, depth++) {
    const codes = new Set<string>();
    for (const a of node.querySelectorAll('a[href]')) {
      const code = postCodeFromHref(a.getAttribute('href')!);
      if (code) codes.add(code);
    }
    if (codes.size === 1) return [...codes][0];
    if (codes.size > 1) return null;
  }
  return null;
}

export async function resolveMedia(ref: MediaRef): Promise<MediaItem | null> {
  try {
    const res = await fetch(`/api/v1/media/${ref.pk}/info/`, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': APP_ID },
    });
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const item = (await res.json())?.items?.[0] as MediaItem | undefined;
      if (item) return item;
    }
  } catch {
    // Fall through to the embedded data.
  }
  return findEmbedded(ref);
}

/** Searches the JSON Instagram embeds in the page for the media. */
function findEmbedded(ref: MediaRef): MediaItem | null {
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? '';
    if (!text.includes(ref.pk) && !(ref.code && text.includes(ref.code))) continue;
    try {
      const found = findItem(JSON.parse(text), ref);
      if (found) return found;
    } catch {
      // Not JSON we understand.
    }
  }
  return null;
}

function findItem(root: unknown, ref: MediaRef): MediaItem | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const item = node as MediaItem;
    const matches =
      String(item.pk) === ref.pk || (ref.code !== undefined && item.code === ref.code) || item.id?.startsWith(`${ref.pk}_`);
    if (matches && (item.video_versions?.length || item.image_versions2?.candidates?.length)) return item;
    stack.push(...Object.values(node));
  }
  return null;
}

/** The biggest version. Without dimensions (some embedded data), keep Instagram's order: best first. */
const largest = (versions: Version[] | undefined) =>
  [...(versions ?? [])].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];

/** The best video file; in a carousel, the video whose length matches the one playing. */
export function bestVideo(item: MediaItem, duration: number): Download | null {
  const videos = item.carousel_media?.filter((m) => m.video_versions?.length) ?? [item];
  const pick = Number.isFinite(duration)
    ? [...videos].sort((a, b) => Math.abs((a.video_duration ?? 0) - duration) - Math.abs((b.video_duration ?? 0) - duration))[0]
    : videos[0];
  const version = largest(pick?.video_versions);
  if (!version) return null;
  return { url: version.url, filename: filename(item, pick, version.url, 'mp4') };
}

/** The largest image; in a carousel, the slide whose file matches the one displayed. */
export function bestImage(item: MediaItem, displayedSrc: string): Download | null {
  const slides = item.carousel_media ?? [item];
  const key = fileKey(displayedSrc);
  const pick =
    slides.find((m) => m.image_versions2?.candidates?.some((c) => fileKey(c.url) === key)) ??
    (slides.length === 1 ? slides[0] : null);
  const version = largest(pick?.image_versions2?.candidates);
  if (!pick || !version) return null;
  return { url: version.url, filename: filename(item, pick, version.url, 'jpg') };
}

/** Fallback without media data: the largest size the page itself offers in srcset. */
export function largestFromSrcset(img: HTMLImageElement): Download | null {
  let best = { url: img.currentSrc || img.src, width: img.naturalWidth };
  for (const entry of img.srcset.split(',')) {
    const [url, size] = entry.trim().split(/\s+/);
    const width = parseInt(size ?? '', 10);
    if (url && width > best.width) best = { url, width };
  }
  if (!best.url) return null;
  return { url: best.url, filename: `instagram_${fileKey(best.url).replace(/\.\w+$/, '')}.${extension(best.url, 'jpg')}` };
}

/** Images of one photo share their file name across sizes; only the query string differs. */
function fileKey(url: string): string {
  try {
    return new URL(url, location.href).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

function extension(url: string, fallback: string): string {
  return fileKey(url).match(/\.(\w+)$/)?.[1] ?? fallback;
}

function filename(item: MediaItem, pick: MediaItem, url: string, fallbackExt: string): string {
  const user = item.user?.username ?? 'instagram';
  const id = item.code ?? String(item.pk ?? pick.pk ?? 'media');
  const slides = item.carousel_media;
  const slide = slides && slides.length > 1 ? `_${slides.indexOf(pick) + 1}` : '';
  return `${user}_${id}${slide}.${extension(url, fallbackExt)}`.replace(/[^\w.-]/g, '_');
}

/** Hands the file to the background worker, which saves it with chrome.downloads (CDN files are cross-origin). */
export async function startDownload(download: Download): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'download', ...download });
    return response?.ok === true;
  } catch {
    return false;
  }
}
