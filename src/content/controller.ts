import css from './styles.css?inline';
import { buildUI, setDownloadState, setIcon, type ControlsUI } from './ui';
import {
  bestDash, bestVideo, fetchBytes, findMediaRef, resolveMedia, saveBlob, startDownload, type DashPair, type MediaItem,
} from './media';
import { mergeTracks } from './mux';
import { debug } from './debug';
import { isGridTile, isReelsPage, isStoriesPage } from './page';
import { formatSpeed, formatTime } from '../shared/format';
import { SPEEDS, type ReelsEnd, type Settings } from '../shared/settings';

export interface ControllerHost {
  readonly settings: Settings;
  /** Applies a settings change to every video and persists it. */
  update(patch: Partial<Settings>): void;
}

const HOST_TAG = 'ivc-overlay';
const HIDE_DELAY = 2000;
const MIN_WIDTH = 140;
const MIN_HEIGHT = 100;
const OCCLUSION_INTERVAL = 250;
const BAR_HEIGHT = 74;
/** Stories pill: width, gap to the story's right edge, and room kept free above and below it. */
const SIDE_WIDTH = 44;
const SIDE_INSET = 8;
const SIDE_MARGIN_Y = 80;
const SIDE_MAX_HEIGHT = 520;
/** Height of everything in the expanded pill except its progress bar. */
const SIDE_CONTROLS_HEIGHT = 334;
/** How long after a click on Instagram's UI a mute change still counts as the user's doing. */
const USER_CLICK_WINDOW = 600;
/** Auto-next triggers this close to the end, before Instagram gets a chance to loop. */
const END_MARGIN = 0.25;

// Events that must not reach Instagram's handlers (play/pause toggles, story taps, outside-click closers).
const ISOLATED_EVENTS = [
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick',
  'touchstart', 'touchend', 'contextmenu',
] as const;

// Matched against aria-labels and SVG titles of Instagram's buttons, in a few common languages.
const MUTE_LABEL = /audio|sound|mute|volume|\bses|\bton\b|\bson\b|sonido|áudio|suono|звук/i;
const NEXT_LABEL = /\bnext\b|sonraki|weiter|suivant|siguiente|avanti|próximo|далее/i;

/** Last trusted click on Instagram's own UI (not our overlay). */
const pageClick = { time: -Infinity, target: null as Element | null };
window.addEventListener('click', (e) => {
  const target = e.composedPath()[0];
  // Clicks inside our closed shadow root are retargeted to the host element.
  if (!e.isTrusted || !(target instanceof Element) || target.localName === HOST_TAG) return;
  pageClick.time = performance.now();
  pageClick.target = target;
}, { capture: true, passive: true });

const END_LABELS: Record<ReelsEnd, string> = { loop: 'Loop', next: 'Play next reel', stop: 'Stop at end' };

export class VideoController {
  readonly host: HTMLElement;
  private readonly ui: ControlsUI;
  private readonly ac = new AbortController();

  private intersecting = false;
  private shown = false;
  private rect: DOMRect | null = null;
  private lastOcclusionCheck = 0;
  private occluded = false;
  /** Hover-preview tile in a grid (explore, profile): no controls. Null until it can be measured. */
  private gridTile: boolean | null;

  private lastActivity = 0;
  private barHovered = false;
  private scrubbing = false;
  private scrubFraction = 0;
  private draggingVolume = false;

  private frameDuration = 1 / 30;
  private osdTimer: ReturnType<typeof setTimeout> | undefined;

  private fsTarget: HTMLElement | null = null;
  private fsSaved = { objectFit: '', width: '', height: '', background: '' };

  /** Mute state the user chose with our controls; Instagram is not allowed to change it behind our back. */
  private wantMuted: boolean | null = null;
  private lastMuted: boolean;
  private igMuteButton: WeakRef<HTMLElement> | null = null;

  /** Loop state the user chose with our controls, enforced over Instagram's own looping. */
  private loopOverride: boolean | null = null;
  /** Instagram loops reels with its own code (video.loop stays false); seen on the reels feed. */
  private igLoops = isReelsPage();
  private lastTime = 0;
  private lastOwnSeek = -Infinity;
  private lastOwnPlay = -Infinity;
  private endedAt = -Infinity;
  private advanced = false;

  // Cached render state so per-frame updates only touch the DOM when something changed.
  private lastTimeText = '';
  private lastPaused: boolean | null = null;
  /** Media data for the current video, fetched once per source. */
  private mediaCache: { key: string; item: Promise<MediaItem | null> } | null = null;
  private downloading = false;
  private lastEndMode = '';

  constructor(readonly video: HTMLVideoElement, private readonly ctx: ControllerHost) {
    this.lastMuted = video.muted;
    // Everything that plays on the explore grid is a hover preview, including tiles still in the DOM
    // behind a reel opened from it (by then the URL is /reels/...).
    this.gridTile = location.pathname.startsWith('/explore') && !video.closest('[role="dialog"]') ? true : null;
    this.host = document.createElement(HOST_TAG);
    this.host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;display:none;contain:layout style;';
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;
    this.ui = buildUI();
    root.append(style, this.ui.wrap);
    document.body.append(this.host);

    this.bindVideo();
    this.bindUI();
    this.applySettings(ctx.settings);
    this.trackFrameRate();
    this.renderAll();
  }

  // ---------- lifecycle ----------

  destroy(): void {
    if (this.fsTarget && document.fullscreenElement === this.fsTarget) void document.exitFullscreen();
    this.restoreFullscreenStyles();
    this.ac.abort();
    clearTimeout(this.osdTimer);
    this.host.remove();
  }

  setIntersecting(value: boolean): void {
    this.intersecting = value;
    if (!value) this.setShown(false, 'offscreen');
  }

  applySettings(patch: Partial<Settings>): void {
    if (patch.speed !== undefined) this.enforceSpeed();
    if (patch.volume !== undefined && Math.abs(this.video.volume - patch.volume) > 0.001) {
      this.video.volume = patch.volume;
    }
    if (patch.progressLine !== undefined) this.ui.wrap.classList.toggle('show-line', patch.progressLine);
    if (patch.reelsEnd !== undefined) this.renderLoop();
    this.renderSpeed();
  }

  // ---------- per-frame update, driven by the global rAF loop ----------

  frame(now: number): void {
    if (!this.intersecting) return;
    this.checkEnd();
    const isFs = this.isFullscreen;
    // In fullscreen, cover the whole screen: any click outside our overlay would land on Instagram's
    // DOM, where feed videos sit inside a link to the reel.
    const r = isFs ? new DOMRect(0, 0, window.innerWidth, window.innerHeight) : this.video.getBoundingClientRect();
    if (!isFs && now - this.lastOcclusionCheck > OCCLUSION_INTERVAL) {
      this.lastOcclusionCheck = now;
      this.occluded = this.checkOccluded(r, Math.min(r.bottom, window.innerHeight));
    }
    // Stories: a small pill on the story's right edge instead of a bar over Instagram's reply box.
    const side = !isFs && isStoriesPage();
    // Clamp to the viewport so the bar sits at the visible bottom of tall or partly scrolled videos.
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const visibleHeight = bottom - top;

    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT || visibleHeight < Math.min(MIN_HEIGHT, r.height)) {
      this.setShown(false, 'too small');
      return;
    }
    this.gridTile ??= isGridTile(this.video, r);
    if (this.gridTile) {
      this.setShown(false, 'grid preview');
      return;
    }
    if (!isFs && this.occluded) {
      this.setShown(false, 'covered');
      return;
    }
    this.setShown(true, 'visible');

    this.rect = r;
    const s = this.host.style;
    if (side) {
      // The host reserves room for the expanded pill; the pill itself is centred in it and only it
      // takes pointer events, so the unused space doesn't block the story.
      const height = Math.min(r.height - 2 * SIDE_MARGIN_Y, SIDE_MAX_HEIGHT);
      s.left = `${r.right - SIDE_WIDTH - SIDE_INSET}px`;
      s.top = `${r.top + (r.height - height) / 2}px`;
      s.width = `${SIDE_WIDTH}px`;
      s.height = `${height}px`;
      const progress = Math.min(Math.max(height - SIDE_CONTROLS_HEIGHT, 40), 110);
      this.ui.wrap.style.setProperty('--side-progress', `${progress}px`);
      this.ui.speedMenu.style.setProperty('--menu-max', `${Math.max(120, r.height * 0.7)}px`);
    } else {
      s.left = `${r.left}px`;
      s.top = `${top}px`;
      s.width = `${r.width}px`;
      s.height = `${visibleHeight}px`;
      this.ui.speedMenu.style.setProperty('--menu-max', `${Math.max(120, visibleHeight - BAR_HEIGHT)}px`);
    }
    this.ui.wrap.classList.toggle('side', side);

    const menuOpen = this.ui.speedMenu.classList.contains('open') || this.ui.downloadMenu.classList.contains('open');
    this.ui.wrap.classList.toggle('expanded', side && (this.barHovered || this.scrubbing || this.draggingVolume || menuOpen));
    // The stories pill is small and out of the way, so it stays visible (collapsed) instead of fading.
    const active =
      side || this.scrubbing || this.draggingVolume || this.barHovered || menuOpen ||
      this.video.paused || now - this.lastActivity < HIDE_DELAY;
    this.ui.wrap.classList.toggle('idle', !active);
    this.ui.wrap.classList.toggle('stories', isStoriesPage());

    this.renderProgress();
    this.renderTime();
    this.renderPlayState();
    this.renderLoop();
  }

  get isShown(): boolean {
    return this.shown;
  }

  get isFullscreen(): boolean {
    return this.fsTarget !== null && document.fullscreenElement === this.fsTarget;
  }

  /** Marks user activity so the bar becomes visible. */
  wake(): void {
    this.lastActivity = performance.now();
  }

  hitTest(x: number, y: number): boolean {
    const r = this.rect;
    return this.shown && r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  visibleArea(): number {
    const r = this.rect;
    if (!this.shown || !r) return 0;
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return Math.max(0, w) * Math.max(0, h);
  }

  // ---------- actions (used by UI and keyboard shortcuts) ----------

  togglePlay(): void {
    const { video } = this;
    if (video.paused || video.ended) {
      // Stopped at the end because loop is off: start over.
      if (Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.1) this.seekTo(0);
      this.lastOwnPlay = performance.now();
      video.play().catch(() => {});
      this.flash('▶');
    } else {
      video.pause();
      this.flash('❚❚');
    }
  }

  seekTo(seconds: number): void {
    const d = this.video.duration;
    if (!Number.isFinite(d)) return;
    this.lastOwnSeek = performance.now();
    this.video.currentTime = Math.min(Math.max(seconds, 0), Math.max(d - 0.05, 0));
  }

  seekBy(seconds: number): void {
    this.seekTo(this.video.currentTime + seconds);
    this.flash(`${seconds > 0 ? '+' : '−'}${Math.abs(seconds)}s`);
  }

  seekToFraction(fraction: number): void {
    const d = this.video.duration;
    if (!Number.isFinite(d)) return;
    this.seekTo(d * fraction);
    this.flash(formatTime(d * fraction));
  }

  setSpeed(speed: number): void {
    this.ctx.update({ speed });
    this.flash(formatSpeed(speed));
  }

  stepSpeed(direction: 1 | -1): void {
    const current = this.ctx.settings.speed;
    const next =
      direction > 0
        ? SPEEDS.find((s) => s > current + 0.001) ?? SPEEDS[SPEEDS.length - 1]
        : [...SPEEDS].reverse().find((s) => s < current - 0.001) ?? SPEEDS[0];
    this.setSpeed(next);
  }

  toggleMute(): void {
    this.setMuted(!this.video.muted);
    if (!this.video.muted && this.video.volume === 0) this.setVolume(0.5);
    this.flash(this.video.muted ? 'Muted' : `Volume ${Math.round(this.video.volume * 100)}%`);
  }

  setVolume(volume: number): void {
    const v = Math.min(Math.max(volume, 0), 1);
    this.video.volume = v;
    if (v > 0 && this.video.muted) this.setMuted(false);
    this.ctx.update({ volume: v });
  }

  changeVolume(delta: number): void {
    const base = this.video.muted ? 0 : this.video.volume;
    this.setVolume(base + delta);
    this.flash(`Volume ${Math.round(this.video.volume * 100)}%`);
  }

  /** Loop → play next reel → stop on reels pages (remembered); loop ↔ stop for this video elsewhere. */
  cycleEndMode(): void {
    if (isReelsPage()) {
      const order: ReelsEnd[] = ['loop', 'next', 'stop'];
      const next = order[(order.indexOf(this.ctx.settings.reelsEnd) + 1) % order.length];
      this.ctx.update({ reelsEnd: next });
      this.flash(END_LABELS[next]);
    } else {
      this.loopOverride = !this.loops;
      this.video.loop = this.loopOverride;
      this.flash(END_LABELS[this.loopOverride ? 'loop' : 'stop']);
    }
    this.renderLoop();
  }

  /** Quick download (d): the best single MP4 with audio. */
  async download(): Promise<void> {
    const button = this.ui.downloadBtn;
    if (button.classList.contains('busy')) return;
    setDownloadState(button, 'busy');
    this.flash('Preparing download…');
    const item = await this.media();
    const file = item && bestVideo(item, this.video.duration);
    debug('download', file);
    const ok = !!file && (await startDownload(file));
    setDownloadState(button, ok ? 'done' : 'failed');
    this.flash(ok ? 'Downloading' : 'Download unavailable');
    setTimeout(() => setDownloadState(button, 'idle'), ok ? 1500 : 2500);
  }

  /** Saves the frame on screen as a PNG at the video's full resolution (s). */
  async saveFrame(): Promise<boolean> {
    const { video } = this;
    try {
      if (!video.videoWidth) throw new Error('No frame yet');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Encoding failed');
      const ref = findMediaRef(video);
      const item = await this.mediaCache?.item;
      const id = item?.code ?? item?.pk ?? ref?.code ?? ref?.pk ?? 'instagram';
      const name = [item?.user?.username, id, `${video.currentTime.toFixed(2)}s`].filter(Boolean).join('_');
      saveBlob(blob, `${name}.png`);
      this.flash('Frame saved');
      return true;
    } catch (error) {
      debug('frame', error);
      this.flash('Frame unavailable');
      return false;
    }
  }

  stepFrame(direction: 1 | -1): void {
    this.video.pause();
    this.seekTo(this.video.currentTime + direction * this.frameDuration);
    this.flash(direction > 0 ? 'Frame ▸' : '◂ Frame');
  }

  async togglePip(): Promise<void> {
    try {
      if (document.pictureInPictureElement === this.video) {
        await document.exitPictureInPicture();
      } else {
        this.video.disablePictureInPicture = false;
        await this.video.requestPictureInPicture();
      }
    } catch {
      this.flash('Picture-in-picture unavailable');
    }
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      // Fullscreen the video's parent (not the video itself) so our overlay can live inside it.
      const target = this.video.parentElement;
      if (!target) return;
      this.fsTarget = target;
      await target.requestFullscreen();
    } catch {
      this.fsTarget = null;
      this.flash('Fullscreen unavailable');
    }
  }

  // ---------- internals ----------

  private get loops(): boolean {
    return this.loopOverride ?? (this.video.loop || this.igLoops);
  }

  /** What happens at the end of this video, or null to leave it to Instagram. */
  private endMode(): ReelsEnd | null {
    if (isReelsPage()) {
      const mode = this.ctx.settings.reelsEnd;
      // Scrolling the feed would leave fullscreen showing a paused reel; loop instead.
      return mode === 'next' && this.isFullscreen ? 'loop' : mode;
    }
    return this.loopOverride === null ? null : this.loopOverride ? 'loop' : 'stop';
  }

  private setShown(value: boolean, reason: string): void {
    if (this.shown === value) return;
    this.shown = value;
    this.host.style.display = value ? 'block' : 'none';
    if (!value) this.closeMenu();
    debug(value ? 'show' : 'hide', reason, this.video);
  }

  /**
   * True when a separate layer (a modal, fixed nav bar, menu) covers the spot where our bar would be.
   * Instagram's own overlays on the video (tap zones, captions, story reply bar) share an ancestor
   * with the video before reaching any fixed layer or dialog, so they don't count.
   */
  private checkOccluded(r: DOMRect, visibleBottom: number): boolean {
    const x = r.left + r.width / 2;
    const y = visibleBottom - 12;
    if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) return false;
    // A dialog over this spot hides us even if it lets pointer events through (hit testing skips those).
    for (const dialog of document.querySelectorAll('[role="dialog"], dialog[open]')) {
      if (dialog.contains(this.video)) continue;
      const b = dialog.getBoundingClientRect();
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom && getComputedStyle(dialog).visibility !== 'hidden') {
        debug('covered by dialog', dialog);
        return true;
      }
    }
    const hit = document.elementsFromPoint(x, y).find((el) => el.localName !== HOST_TAG);
    for (let el = hit ?? null; el && el !== document.body; el = el.parentElement) {
      if (el.contains(this.video)) return false;
      if (el.getAttribute('role') === 'dialog' || el.localName === 'dialog') return true;
      const { position } = getComputedStyle(el);
      if (position === 'fixed' || position === 'sticky') {
        debug('covered by', el);
        return true;
      }
    }
    return false;
  }

  private bindVideo(): void {
    const { video } = this;
    const opts = { signal: this.ac.signal };
    // Instagram resets playbackRate when it swaps sources; keep forcing the remembered speed.
    for (const type of ['loadstart', 'loadedmetadata', 'play', 'ratechange'] as const) {
      video.addEventListener(type, () => this.enforceSpeed(), opts);
    }
    video.addEventListener('loadstart', () => {
      // New media: per-video choices start fresh.
      this.mediaCache = null;
      this.loopOverride = null;
      this.igLoops = isReelsPage();
      this.advanced = false;
      this.lastTime = 0;
    }, opts);
    video.addEventListener('loadedmetadata', () => this.trackFrameRate(), opts);
    video.addEventListener('volumechange', () => this.onVolumeChange(), opts);
    video.addEventListener('timeupdate', () => this.checkEnd(), opts);
    video.addEventListener('ended', () => {
      this.endedAt = performance.now();
      if (this.endMode() === 'next') this.advance();
    }, opts);
    video.addEventListener('play', () => {
      // Instagram restarts reels itself after `ended`; respect "stop at end".
      const restartedByInstagram = performance.now() - this.endedAt < 500 && performance.now() - this.lastOwnPlay > 500;
      if (restartedByInstagram) this.igLoops = true;
      if (this.endMode() === 'stop' && restartedByInstagram) this.stopAtEnd();
    }, opts);
    video.addEventListener('enterpictureinpicture', () => this.ui.pipBtn.classList.add('on'), opts);
    video.addEventListener('leavepictureinpicture', () => this.ui.pipBtn.classList.remove('on'), opts);
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange(), opts);
  }

  private bindUI(): void {
    const { ui } = this;
    const opts = { signal: this.ac.signal };

    for (const target of [ui.bar, ui.catcher]) {
      for (const type of ISOLATED_EVENTS) target.addEventListener(type, (e) => e.stopPropagation(), opts);
      // Keep focus out of our buttons so Space keeps working as a shortcut instead of "pressing" them.
      target.addEventListener('mousedown', (e) => e.preventDefault(), opts);
      // In fullscreen the overlay sits inside Instagram's DOM, where feed videos are wrapped in a link to
      // the reel. stopPropagation doesn't stop a link from navigating; cancelling the click does.
      for (const type of ['click', 'auxclick'] as const) target.addEventListener(type, (e) => e.preventDefault(), opts);
    }
    ui.catcher.addEventListener('click', () => this.togglePlay(), opts);
    ui.bar.addEventListener('pointerenter', () => (this.barHovered = true), opts);
    ui.bar.addEventListener('pointerleave', () => (this.barHovered = false), opts);
    ui.bar.addEventListener('wheel', (e) => this.onWheel(e), { ...opts, passive: false });

    ui.playBtn.addEventListener('click', () => this.togglePlay(), opts);
    ui.muteBtn.addEventListener('click', () => this.toggleMute(), opts);
    ui.loopBtn.addEventListener('click', () => this.cycleEndMode(), opts);
    ui.backBtn.addEventListener('click', () => this.seekBy(-5), opts);
    ui.forwardBtn.addEventListener('click', () => this.seekBy(5), opts);
    ui.pipBtn.addEventListener('click', () => void this.togglePip(), opts);
    ui.downloadBtn.addEventListener('click', () => void this.toggleDownloadMenu(), opts);
    ui.fsBtn.addEventListener('click', () => void this.toggleFullscreen(), opts);

    ui.speedBtn.addEventListener('click', () => {
      ui.downloadMenu.classList.remove('open');
      ui.speedMenu.classList.toggle('open');
    }, opts);
    for (const item of ui.speedItems) {
      item.addEventListener('click', () => {
        this.setSpeed(Number(item.dataset.speed));
        this.closeMenu();
      }, opts);
    }
    // Close the menu on clicks elsewhere. Outside listeners can't see into our closed shadow root,
    // so clicks inside the host are handled by the bar listener instead.
    window.addEventListener('pointerdown', (e) => {
      if (!e.composedPath().includes(this.host)) this.closeMenu();
    }, { ...opts, capture: true });
    ui.bar.addEventListener('pointerdown', (e) => {
      const path = e.composedPath();
      if (!path.includes(ui.speedMenu.parentElement!)) ui.speedMenu.classList.remove('open');
      if (!path.includes(ui.downloadMenu.parentElement!) && !this.downloading) ui.downloadMenu.classList.remove('open');
    }, { ...opts, capture: true });

    this.bindScrubbing();
    this.bindVolumeSlider();
  }

  private bindScrubbing(): void {
    const { progress, tip } = this.ui;
    const opts = { signal: this.ac.signal };
    // The progress bar runs top-to-bottom in the stories pill.
    const vertical = () => this.ui.wrap.classList.contains('side');
    const fractionAt = (e: PointerEvent) => {
      const r = progress.getBoundingClientRect();
      const f = vertical() ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      return Math.min(Math.max(f, 0), 1);
    };

    // Seek without pausing: Instagram reacts to pause/play events (e.g. re-applying its own mute state).
    progress.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !Number.isFinite(this.video.duration)) return;
      progress.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      progress.classList.add('scrubbing');
      this.scrubFraction = fractionAt(e);
      this.seekTo(this.scrubFraction * this.video.duration);
    }, opts);

    progress.addEventListener('pointermove', (e) => {
      const fraction = fractionAt(e);
      tip.textContent = formatTime(fraction * this.video.duration);
      const [length, tipSize] = vertical()
        ? [progress.clientHeight, tip.offsetHeight]
        : [progress.clientWidth, tip.offsetWidth];
      tip.style.setProperty('--tip', `${clampTip(fraction * length, tipSize, length)}px`);
      if (!this.scrubbing) return;
      this.scrubFraction = fraction;
      this.seekTo(fraction * this.video.duration);
    }, opts);

    const end = () => {
      this.scrubbing = false;
      progress.classList.remove('scrubbing');
    };
    progress.addEventListener('pointerup', end, opts);
    progress.addEventListener('pointercancel', end, opts);
  }

  private bindVolumeSlider(): void {
    const { volume } = this.ui;
    const opts = { signal: this.ac.signal };
    const setFrom = (clientX: number) => {
      const track = volume.firstElementChild!.getBoundingClientRect();
      this.setVolume((clientX - track.left) / track.width);
    };
    volume.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      volume.setPointerCapture(e.pointerId);
      this.draggingVolume = true;
      volume.classList.add('dragging');
      setFrom(e.clientX);
    }, opts);
    volume.addEventListener('pointermove', (e) => this.draggingVolume && setFrom(e.clientX), opts);
    const end = () => {
      this.draggingVolume = false;
      volume.classList.remove('dragging');
    };
    volume.addEventListener('pointerup', end, opts);
    volume.addEventListener('pointercancel', end, opts);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const path = e.composedPath();
    if (path.includes(this.ui.volume) || path.includes(this.ui.muteBtn)) {
      this.changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
      return;
    }
    // Our overlay lives outside Instagram's scroll containers, so forward the scroll to them.
    (findScroller(this.video) ?? document.scrollingElement)?.scrollBy({ left: e.deltaX, top: e.deltaY });
  }

  // ---------- mute: kept in sync with Instagram's own mute button ----------

  private setMuted(muted: boolean): void {
    this.wantMuted = muted;
    if (this.video.muted === muted) return;
    // Prefer Instagram's own button so its icon and remembered mute state follow along.
    const button = this.findInstagramMuteButton();
    if (button) {
      debug('clicking Instagram mute button', button);
      button.click();
    }
    if (this.video.muted !== muted) this.video.muted = muted;
  }

  private onVolumeChange(): void {
    const { video } = this;
    const changed = video.muted !== this.lastMuted;
    const byUser = performance.now() - pageClick.time < USER_CLICK_WINDOW;
    if (changed && byUser) this.learnMuteButton();
    if (this.wantMuted !== null && video.muted !== this.wantMuted) {
      if (byUser) {
        this.wantMuted = video.muted; // the user used Instagram's button: follow it
      } else {
        debug('Instagram changed mute on its own; restoring', this.wantMuted);
        video.muted = this.wantMuted;
        return;
      }
    }
    this.lastMuted = video.muted;
    this.renderVolume();
  }

  /** Remembers which Instagram element toggled mute when the user clicked it. */
  private learnMuteButton(): void {
    const target = pageClick.target;
    const button = target?.closest<HTMLElement>('button, [role="button"]') ?? (target as HTMLElement | null);
    if (button && this.muteSearchScope()?.contains(button)) this.igMuteButton = new WeakRef(button);
  }

  /**
   * Instagram's audio toggle: the smallest labelled button over the video. Size matters because on the
   * reels feed the whole-video tap-to-pause layer is also a button and contains the audio icon.
   */
  private findInstagramMuteButton(): HTMLElement | null {
    const learned = this.igMuteButton?.deref();
    if (learned?.isConnected) return learned;
    const scope = this.muteSearchScope();
    if (!scope) return null;
    const v = this.video.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestArea = (v.width * v.height) / 8;
    for (const button of scope.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      const r = button.getBoundingClientRect();
      const area = r.width * r.height;
      const overVideo = r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom;
      if (area === 0 || area >= bestArea || !overVideo) continue;
      if (labelsOf(button).some((l) => MUTE_LABEL.test(l))) {
        best = button;
        bestArea = area;
      }
    }
    return best;
  }

  /** The largest ancestor of the video that contains no other video. */
  private muteSearchScope(): Element | null {
    let scope: Element | null = null;
    for (let el = this.video.parentElement, depth = 0; el && el !== document.body && depth < 10; el = el.parentElement, depth++) {
      if (el.querySelectorAll('video').length > 1) break;
      scope = el;
    }
    return scope;
  }

  // ---------- end of video: loop, play next reel, or stop ----------

  private checkEnd(): void {
    const { video } = this;
    const mode = this.endMode();
    if (mode !== null && video.loop !== (mode === 'loop')) video.loop = mode === 'loop';
    const d = video.duration;
    const t = video.currentTime;
    const prev = this.lastTime;
    this.lastTime = t;
    if (!Number.isFinite(d) || d < 1 || this.scrubbing || video.paused) return;
    if (t < d - 1) this.advanced = false;
    // Instagram may restart the video between our checks; catch the jump from the end back to the start.
    const wrapped = prev > d - 1 && t < 1 && performance.now() - this.lastOwnSeek > 400;
    if (wrapped && mode === null) this.igLoops = true;
    if (mode === 'next' && (t >= d - END_MARGIN || wrapped)) this.advance();
    else if (mode === 'stop' && wrapped) this.stopAtEnd();
  }

  private stopAtEnd(): void {
    debug('stopping at end');
    this.video.pause();
    this.seekTo(this.video.duration);
  }

  private advance(): void {
    if (this.advanced) return;
    this.advanced = true;
    debug('auto-next');
    this.video.pause();
    this.flash('Next ▸');
    const scroller = findScroller(this.video);
    if (!scroller) {
      goNext(this.video);
      return;
    }
    const before = scroller.scrollTop;
    scroller.scrollBy({ top: snapItemHeight(this.video), behavior: 'smooth' });
    setTimeout(() => {
      if (Math.abs(scroller.scrollTop - before) < 2) goNext(this.video);
    }, 600);
  }

  // ---------- download menu ----------

  private media(): Promise<MediaItem | null> {
    const ref = findMediaRef(this.video);
    if (!ref) return Promise.resolve(null);
    // Stories opened directly have no item id in the URL; a new story item is a new source (loadstart clears this).
    const key = ref.pk ?? ref.code ?? location.pathname;
    if (this.mediaCache?.key !== key) {
      debug('media lookup', { url: location.pathname, ref, duration: this.video.duration });
      const item = resolveMedia(ref, { duration: this.video.duration }).then((found) => {
        if (!found && this.mediaCache?.item === item) this.mediaCache = null; // retry next time
        return found;
      });
      this.mediaCache = { key, item };
    }
    return this.mediaCache.item;
  }

  private async toggleDownloadMenu(): Promise<void> {
    const menu = this.ui.downloadMenu;
    if (menu.classList.contains('open')) {
      if (!this.downloading) menu.classList.remove('open');
      return;
    }
    this.ui.speedMenu.classList.remove('open');
    menu.classList.add('open');
    this.renderDownloadMenu(null, true);
    const item = await this.media();
    if (menu.classList.contains('open') && !this.downloading) this.renderDownloadMenu(item, false);
  }

  /** Lists what can be downloaded for this video; options needing media data appear once it's loaded. */
  private renderDownloadMenu(item: MediaItem | null, loading: boolean): void {
    const menu = this.ui.downloadMenu;
    menu.replaceChildren();
    const { video } = this;
    const add = (title: string, note: string, action?: (setNote: (text: string) => void) => Promise<boolean>) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'menu-item';
      row.setAttribute('role', 'menuitem');
      const titleEl = document.createElement('span');
      titleEl.textContent = title;
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.textContent = note;
      row.append(titleEl, noteEl);
      if (!action) row.setAttribute('aria-disabled', 'true');
      else row.addEventListener('click', () => void this.runDownload(row, (text) => (noteEl.textContent = text), action));
      menu.append(row);
    };

    const single = item && bestVideo(item, video.duration);
    const dash = item && bestDash(item, video.duration);
    if (single) {
      add('Video with audio', [single.quality && `${single.quality}p`, 'one MP4'].filter(Boolean).join(' · '), async () =>
        startDownload(single));
    }
    if (dash) {
      const quality = `${Math.min(dash.video.width, dash.video.height)}p`;
      // VP9/AV1 streams play in web browsers, but many desktop and phone players can't open them.
      const browserOnly = /^(vp09|av01)/.test(dash.video.codecs) ? ' · opens in browsers only' : '';
      add('Best quality, merged', `${quality}${browserOnly} · takes a moment`, (setNote) => this.downloadMerged(dash, quality, setNote));
      add('Best quality, separate files', `${quality} video + audio track${browserOnly}`, async () => {
        const videoOk = await startDownload({ url: dash.video.url, filename: `${dash.baseName}_${quality}_video.mp4` });
        const audioOk = await startDownload({ url: dash.audio.url, filename: `${dash.baseName}_audio.mp4` });
        return videoOk && audioOk;
      });
    }
    if (loading) add('Finding download options…', 'Asking Instagram for the original files');
    else if (!single && !dash) add('No downloadable file found', 'Instagram didn’t return this video’s files');
    add('Current frame', video.videoWidth ? `PNG · ${video.videoWidth}×${video.videoHeight}` : 'PNG', () => this.saveFrame());
  }

  private async runDownload(
    row: HTMLButtonElement,
    setNote: (text: string) => void,
    action: (setNote: (text: string) => void) => Promise<boolean>,
  ): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    row.setAttribute('aria-disabled', 'true');
    setDownloadState(this.ui.downloadBtn, 'busy');
    let ok = false;
    try {
      ok = await action(setNote);
    } catch (error) {
      debug('download failed', error);
    }
    this.downloading = false;
    setNote(ok ? 'Saved to your downloads' : 'Download failed');
    setDownloadState(this.ui.downloadBtn, ok ? 'done' : 'failed');
    setTimeout(() => {
      this.ui.downloadMenu.classList.remove('open');
      setDownloadState(this.ui.downloadBtn, 'idle');
    }, ok ? 1200 : 2500);
  }

  /** Downloads the best video and audio streams and merges them into one MP4 here. */
  private async downloadMerged(dash: DashPair, quality: string, setNote: (text: string) => void): Promise<boolean> {
    const received = { video: 0, audio: 0 };
    const totals = { video: 0, audio: 0 };
    const report = () => {
      const total = totals.video + totals.audio;
      setNote(total ? `Downloading… ${Math.floor(((received.video + received.audio) / total) * 100)}%` : 'Downloading…');
    };
    report();
    const [videoBytes, audioBytes] = await Promise.all(
      (['video', 'audio'] as const).map((kind) =>
        fetchBytes(dash[kind].url, (got, total) => {
          received[kind] = got;
          totals[kind] = total;
          report();
        }),
      ),
    );
    setNote('Merging…');
    await new Promise((resolve) => setTimeout(resolve)); // let the note paint
    saveBlob(mergeTracks(videoBytes, audioBytes), `${dash.baseName}_${quality}.mp4`);
    return true;
  }

  // ---------- fullscreen ----------

  private onFullscreenChange(): void {
    const target = this.fsTarget;
    if (!target) return;
    if (document.fullscreenElement === target) {
      // Only the fullscreen element's subtree is rendered, so move the overlay inside it.
      const vs = this.video.style;
      this.fsSaved = { objectFit: vs.objectFit, width: vs.width, height: vs.height, background: target.style.background };
      vs.objectFit = 'contain';
      vs.width = '100%';
      vs.height = '100%';
      target.style.background = '#000';
      target.append(this.host);
      this.ui.wrap.classList.add('fs');
      setIcon(this.ui.fsBtn, 'fullscreenExit');
    } else {
      this.restoreFullscreenStyles();
      document.body.append(this.host);
      this.fsTarget = null;
      this.ui.wrap.classList.remove('fs');
      setIcon(this.ui.fsBtn, 'fullscreen');
    }
    this.wake();
  }

  private restoreFullscreenStyles(): void {
    if (!this.fsTarget) return;
    Object.assign(this.video.style, {
      objectFit: this.fsSaved.objectFit,
      width: this.fsSaved.width,
      height: this.fsSaved.height,
    });
    this.fsTarget.style.background = this.fsSaved.background;
  }

  // ---------- misc ----------

  private enforceSpeed(): void {
    const speed = this.ctx.settings.speed;
    if (Math.abs(this.video.playbackRate - speed) > 0.001) this.video.playbackRate = speed;
    if (Math.abs(this.video.defaultPlaybackRate - speed) > 0.001) this.video.defaultPlaybackRate = speed;
  }

  /** Estimates the frame duration from presented frames, for frame stepping. */
  private trackFrameRate(): void {
    const video = this.video;
    if (!('requestVideoFrameCallback' in video)) return;
    let last = -1;
    let samples = 0;
    let best = Infinity;
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (this.ac.signal.aborted) return;
      const delta = meta.mediaTime - last;
      if (last >= 0 && delta > 0.004 && delta < 0.1) {
        best = Math.min(best, delta);
        samples++;
      }
      last = meta.mediaTime;
      if (samples >= 30) this.frameDuration = best;
      else video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  private closeMenu(): void {
    this.ui.speedMenu.classList.remove('open');
    if (!this.downloading) this.ui.downloadMenu.classList.remove('open');
  }

  private flash(text: string): void {
    const { osd } = this.ui;
    osd.textContent = text;
    osd.classList.add('show');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => osd.classList.remove('show'), 650);
    this.wake();
  }

  // ---------- rendering ----------

  private renderAll(): void {
    this.renderProgress();
    this.renderTime();
    this.renderPlayState();
    this.renderVolume();
    this.renderSpeed();
    this.renderLoop();
  }

  private renderProgress(): void {
    const { video, ui } = this;
    const d = video.duration;
    const fraction = this.scrubbing
      ? this.scrubFraction
      : Number.isFinite(d) && d > 0 ? Math.min(video.currentTime / d, 1) : 0;

    let bufferedEnd = 0;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5) bufferedEnd = Math.max(bufferedEnd, b.end(i));
    }
    const bufferedFraction = Number.isFinite(d) && d > 0 ? Math.min(bufferedEnd / d, 1) : 0;

    // The stylesheet maps these onto the horizontal bar, the idle line, or the stories pill's vertical bar.
    ui.wrap.style.setProperty('--played', String(fraction));
    ui.wrap.style.setProperty('--buffered', String(bufferedFraction));
    ui.progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  private renderTime(): void {
    const current = this.scrubbing ? this.scrubFraction * this.video.duration : this.video.currentTime;
    const currentText = formatTime(current);
    const durationText = formatTime(this.video.duration);
    if (currentText + durationText !== this.lastTimeText) {
      this.lastTimeText = currentText + durationText;
      this.ui.timeCurrent.textContent = currentText;
      this.ui.timeDuration.textContent = durationText;
    }
  }

  private renderPlayState(): void {
    const paused = this.video.paused;
    if (paused === this.lastPaused) return;
    this.lastPaused = paused;
    setIcon(this.ui.playBtn, paused ? 'play' : 'pause');
    this.ui.playBtn.title = paused ? 'Play (k)' : 'Pause (k)';
  }

  private renderVolume(): void {
    const { video, ui } = this;
    const level = video.muted ? 0 : video.volume;
    ui.volumeFill.style.width = `${level * 100}%`;
    setIcon(ui.muteBtn, level === 0 ? 'volumeOff' : level < 0.5 ? 'volumeDown' : 'volumeUp');
    ui.muteBtn.title = video.muted ? 'Unmute (m)' : 'Mute (m)';
  }

  private renderSpeed(): void {
    const speed = this.ctx.settings.speed;
    this.ui.speedBtn.textContent = formatSpeed(speed);
    for (const item of this.ui.speedItems) {
      const current = Math.abs(Number(item.dataset.speed) - speed) < 0.001;
      item.classList.toggle('current', current);
      item.setAttribute('aria-checked', String(current));
    }
  }

  private renderLoop(): void {
    const mode: ReelsEnd = isReelsPage() ? this.ctx.settings.reelsEnd : this.loops ? 'loop' : 'stop';
    if (mode === this.lastEndMode) return;
    this.lastEndMode = mode;
    const button = this.ui.loopBtn;
    setIcon(button, mode === 'next' ? 'next' : 'loop');
    button.classList.toggle('on', mode !== 'stop');
    button.title = `At end: ${END_LABELS[mode].toLowerCase()} (r)`;
    button.setAttribute('aria-label', button.title);
  }
}

/** aria-labels, titles and SVG <title> text of an element and its descendants. */
function labelsOf(el: Element): string[] {
  const labels = [el.getAttribute('aria-label'), el.getAttribute('title')];
  for (const node of el.querySelectorAll('[aria-label], title')) {
    labels.push(node.localName === 'title' ? node.textContent : node.getAttribute('aria-label'));
  }
  return labels.filter((l): l is string => !!l);
}

/** The nearest scrollable ancestor; the page itself only when the video isn't inside a dialog. */
function findScroller(node: Element): Element | null {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  const page = document.scrollingElement;
  if (node.closest('[role="dialog"]') || !page || page.scrollHeight <= page.clientHeight) return null;
  return page;
}

/** Height of the scroll-snap item holding the video (one reel), or the video's own height. */
function snapItemHeight(video: HTMLVideoElement): number {
  for (let el = video.parentElement; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).scrollSnapAlign !== 'none') return el.getBoundingClientRect().height;
  }
  return video.getBoundingClientRect().height;
}

/** Fallback when there's nothing to scroll: Instagram's "Next" button, else its arrow-key navigation. */
function goNext(video: HTMLVideoElement): void {
  const root = video.closest('[role="dialog"]') ?? document;
  for (const button of root.querySelectorAll<HTMLElement>('button, [role="button"], a')) {
    if (labelsOf(button).some((l) => NEXT_LABEL.test(l))) {
      debug('clicking Instagram next button', button);
      button.click();
      return;
    }
  }
  for (const key of ['ArrowDown', 'ArrowRight']) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
  }
}

function clampTip(position: number, tipSize: number, trackLength: number): number {
  const half = tipSize / 2;
  return Math.min(Math.max(position, half), trackLength - half);
}
