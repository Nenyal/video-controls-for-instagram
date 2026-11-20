// Finds the original, highest-resolution file behind a video or image on the page.
//
// Instagram plays videos through MediaSource (blob: URLs) and serves images sized for the viewer's
// screen, so the page itself has no full-quality file. Its media API (what instagram.com itself
// uses) lists every stored version: progressive MP4s for videos and all image sizes up to the
// original upload. When the API isn't available (e.g. logged out), the JSON embedded in the page is
// searched for the same data.

import { debug } from './debug';

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
  /** DASH manifest (XML) listing the separate video and audio streams, including ones above the MP4s' quality. */
  video_dash_manifest?: string;
  image_versions2?: { candidates?: Version[] };
  carousel_media?: MediaItem[];
}

interface MediaRef {
  pk?: string;
  code?: string;
  /** The story or highlight being viewed. Its URL often lacks the item id, so the item is picked out of the whole reel. */
  story?: { username?: string; highlight?: string };
}

/** What's on screen, to pick the right item out of a story reel when there's no id. */
interface MediaHint {
  duration?: number;
  src?: string;
}

export interface Download {
  url: string;
  filename: string;
  /** Shorter side in pixels (e.g. 720 for 720×1280), when known. */
  quality?: number;
}

/** One stream from the DASH manifest. */
interface DashStream {
  url: string;
  width: number;
  height: number;
  bandwidth: number;
  codecs: string;
}

/** The best separate video and audio streams, and the file name to save them under. */
export interface DashPair {
  video: DashStream;
  audio: DashStream;
  baseName: string;
}

/** Instagram shortcodes are the media id in base64 (with its own alphabet). */
function shortcodeToPk(code: string): string {
  let pk = 0n;
  for (const ch of code.slice(0, 11)) pk = pk * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(ch));
  return pk.toString();
}

/** Which post, reel or story an element on the page belongs to. */
export function findMediaRef(el: Element): MediaRef | null {
  const highlight = location.pathname.match(/^\/stories\/highlights\/(\d+)(?:\/(\d+))?/);
  if (highlight) return { pk: highlight[2], story: { highlight: highlight[1] } };
  // /stories/<user>/<item id>/, or just /stories/<user>/ when a story is opened directly.
  const story = location.pathname.match(/^\/stories\/([^/]+)(?:\/(\d+))?/);
  if (story) return { pk: story[2], story: { username: story[1] } };
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

export async function resolveMedia(ref: MediaRef, hint: MediaHint = {}): Promise<MediaItem | null> {
  if (ref.pk) {
    const info = (await apiJson(`/api/v1/media/${ref.pk}/info/`)) as { items?: MediaItem[] } | null;
    if (info?.items?.[0]) return info.items[0];
  }
  if (ref.story) {
    const item = await storyItem(ref, hint);
    if (item) return item;
  }
  return findEmbedded(ref);
}

/** GET from Instagram's web API with the session cookies; null unless it answers with JSON. */
async function apiJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(path, { credentials: 'include', headers: { 'X-IG-App-ID': APP_ID } });
    const type = res.headers.get('content-type') ?? '';
    debug('api', path, res.status, type.split(';')[0]);
    if (res.ok && type.includes('json')) return await res.json();
  } catch (error) {
    debug('api', path, 'failed', error);
  }
  return null;
}

/**
 * The story item on screen. A story opened directly comes with its reel embedded in the page, so
 * that's checked first; otherwise the reel is requested by id (the user's id is also in the page).
 */
async function storyItem(ref: MediaRef, hint: MediaHint): Promise<MediaItem | null> {
  const { username, highlight } = ref.story!;
  const embedded = embeddedMedia();
  const own = embedded.filter((m) => m.owner === username);
  const fromPage = matchItem((own.length ? own : embedded).map((m) => withUser(m.item, m.owner)), ref, hint);
  debug('story in page data', { username, embedded: embedded.length, own: own.length, hint, matched: fromPage && String(fromPage.pk) });
  if (fromPage) return fromPage;

  let reelId = highlight ? `highlight:${highlight}` : null;
  if (!reelId && username) reelId = embeddedUserId(username) ?? (await profileUserId(username));
  if (!reelId) return null;
  const data = (await apiJson(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`)) as {
    reels?: Record<string, { items?: MediaItem[] }>;
    reels_media?: { items?: MediaItem[] }[];
  } | null;
  const items = (data?.reels?.[reelId]?.items ?? data?.reels_media?.[0]?.items ?? []).map((i) => withUser(i, username));
  const match = matchItem(items, ref, hint);
  debug('story reel', {
    reelId,
    responseKeys: data && Object.keys(data),
    items: items.map((i) => ({ pk: String(i.pk), duration: i.video_duration, video: !!i.video_versions?.length })),
    hint,
    matched: match && String(match.pk),
  });
  return match;
}

/** Story items in a reel carry no user of their own; give them the reel's, for file names. */
function withUser(item: MediaItem, username: string | undefined): MediaItem {
  return item.user?.username || !username ? item : { ...item, user: { username } };
}

async function profileUserId(username: string): Promise<string | null> {
  const profile = (await apiJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`)) as
    | { data?: { user?: { id?: string } } }
    | null;
  return profile?.data?.user?.id ?? null;
}

/** Parsed JSON blobs Instagram embeds in the page (what it rendered the first view from). */
function embeddedJson(needle: string): unknown[] {
  const roots: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? '';
    if (!text.includes(needle)) continue;
    try {
      roots.push(JSON.parse(text));
    } catch {
      // Not JSON we understand.
    }
  }
  return roots;
}

/** Every media item in the embedded data, with the username of the post/reel it belongs to. */
function embeddedMedia(): { item: MediaItem; owner?: string }[] {
  const found: { item: MediaItem; owner?: string }[] = [];
  const stack: { node: unknown; owner?: string }[] = embeddedJson('_versions').map((node) => ({ node }));
  while (stack.length) {
    const { node, owner: inherited } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    const item = node as MediaItem & { owner?: { username?: string } };
    // Story items often carry no user of their own; their reel does.
    const owner = item.user?.username ?? item.owner?.username ?? inherited;
    if (item.video_versions?.length || item.image_versions2?.candidates?.length) found.push({ item, owner });
    for (const value of Object.values(node)) stack.push({ node: value, owner });
  }
  return found;
}

/** A user's numeric id, from any user object in the embedded data. */
function embeddedUserId(username: string): string | null {
  const stack = embeddedJson(`"${username}"`);
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const user = node as { username?: string; pk?: string | number; id?: string | number; pk_id?: string };
    const id = user.pk ?? user.pk_id ?? user.id;
    if (user.username === username && id !== undefined && /^\d+$/.test(String(id))) return String(id);
    stack.push(...Object.values(node));
  }
  return null;
}

/** The reel item on screen: by id when known, else by image file name or video length. */
function matchItem(items: MediaItem[], ref: MediaRef, hint: MediaHint): MediaItem | null {
  if (ref.pk) {
    const exact = items.find((i) => String(i.pk) === ref.pk || i.id?.startsWith(`${ref.pk}_`));
    if (exact) return exact;
  }
  if (hint.src) {
    const key = fileKey(hint.src);
    const byFile = items.find((i) => i.image_versions2?.candidates?.some((c) => fileKey(c.url) === key));
    if (byFile) return byFile;
  }
  const duration = hint.duration;
  if (duration !== undefined && Number.isFinite(duration)) {
    const distance = (i: MediaItem) => Math.abs((i.video_duration ?? Infinity) - duration);
    const closest = items.filter((i) => i.video_versions?.length).sort((a, b) => distance(a) - distance(b))[0];
    if (closest && distance(closest) < 1.5) return closest;
  }
  return null;
}

/** Searches the JSON Instagram embeds in the page for the media. */
function findEmbedded(ref: MediaRef): MediaItem | null {
  if (!ref.pk && !ref.code) return null;
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? '';
    if (!(ref.pk && text.includes(ref.pk)) && !(ref.code && text.includes(ref.code))) continue;
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

/** The video being played; in a carousel, the slide whose length matches it. */
function videoSlide(item: MediaItem, duration: number): MediaItem | undefined {
  const videos = item.carousel_media?.filter((m) => m.video_versions?.length) ?? [item];
  return Number.isFinite(duration)
    ? [...videos].sort((a, b) => Math.abs((a.video_duration ?? 0) - duration) - Math.abs((b.video_duration ?? 0) - duration))[0]
    : videos[0];
}

/** The best single MP4 with audio. */
export function bestVideo(item: MediaItem, duration: number): Download | null {
  const pick = videoSlide(item, duration);
  const version = largest(pick?.video_versions);
  if (!pick || !version) return null;
  const quality = Math.min(version.width, version.height) || undefined;
  return { url: version.url, filename: `${baseName(item, pick)}.${extension(version.url, 'mp4')}`, quality };
}

/** The highest-quality video stream and the best audio stream from the DASH manifest. */
export function bestDash(item: MediaItem, duration: number): DashPair | null {
  const pick = videoSlide(item, duration);
  const mpd = pick?.video_dash_manifest;
  if (!pick || !mpd) return null;
  const video: DashStream[] = [];
  const audio: DashStream[] = [];
  for (const [, setAttrs, setBody] of mpd.matchAll(/<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    for (const [, attrs, body] of setBody.matchAll(/<Representation([^>]*)>([\s\S]*?)<\/Representation>/g)) {
      const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? setAttrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
      const url = body.match(/<BaseURL>([^<]*)<\/BaseURL>/)?.[1];
      if (!url) continue;
      const stream = {
        url: decodeXml(url),
        width: Number(attr('width')) || 0,
        height: Number(attr('height')) || 0,
        bandwidth: Number(attr('bandwidth')) || 0,
        codecs: attr('codecs'),
      };
      const kind = `${attr('mimeType')} ${attr('contentType')}`;
      (kind.includes('audio') ? audio : kind.includes('video') ? video : []).push(stream);
    }
  }
  const bestVideoStream = video.sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth)[0];
  const bestAudioStream = audio.sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!bestVideoStream || !bestAudioStream) return null;
  return { video: bestVideoStream, audio: bestAudioStream, baseName: baseName(item, pick) };
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!);
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
  return { url: version.url, filename: `${baseName(item, pick)}.${extension(version.url, 'jpg')}` };
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

/** user_postcode, plus the slide number in carousels. */
function baseName(item: MediaItem, pick: MediaItem): string {
  const user = item.user?.username ?? 'instagram';
  const id = item.code ?? String(item.pk ?? pick.pk ?? 'media');
  const slides = item.carousel_media;
  const slide = slides && slides.length > 1 ? `_${slides.indexOf(pick) + 1}` : '';
  return `${user}_${id}${slide}`.replace(/[^\w.-]/g, '_');
}

/** Downloads a file into memory, reporting bytes received. */
export async function fetchBytes(url: string, onProgress: (received: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Saves a file generated here (merged video, frame). Blob URLs are same-origin, so <a download> works. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
