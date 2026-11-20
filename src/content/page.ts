// Which Instagram page or layout something is on.

const POST_LINK = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';

export function isReelsPage(): boolean {
  return /^\/reels?\//.test(location.pathname);
}

export function isStoriesPage(): boolean {
  return /^\/stories\//.test(location.pathname);
}

/**
 * True for a video or image inside a grid tile: walking up from it, the first container holding
 * several posts has another post beside it on the same row. Feeds stack posts vertically instead.
 */
export function isGridTile(media: Element, v: DOMRect): boolean {
  for (let el = media.parentElement, depth = 0; el && el !== document.body && depth < 10; el = el.parentElement, depth++) {
    const links = [...el.querySelectorAll(POST_LINK)];
    if (new Set(links.map((a) => a.getAttribute('href'))).size < 2) continue;
    return links.some((a) => {
      if (a.contains(media)) return false;
      const b = a.getBoundingClientRect();
      const sameRow = b.width > 0 && Math.abs(b.top - v.top) < v.height / 2;
      return sameRow && (b.right <= v.left + 2 || b.left >= v.right - 2);
    });
  }
  return false;
}
