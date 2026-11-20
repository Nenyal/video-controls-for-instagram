import css from './styles.css?inline';
import { buildUI, setIcon, type ControlsUI } from './ui';
import { formatSpeed, formatTime } from '../shared/format';
import { SPEEDS, type Settings } from '../shared/settings';

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
/** How long after a click on Instagram's UI a mute change still counts as the user's doing. */
const USER_CLICK_WINDOW = 600;
/** Auto-next triggers this close to the end, before Instagram gets a chance to loop. */
const END_MARGIN = 0.25;

// Events that must not reach Instagram's handlers (play/pause toggles, story taps, outside-click closers).
const ISOLATED_EVENTS = [
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
  'touchstart', 'touchend', 'contextmenu',
] as const;

// Matched against aria-labels and SVG titles of Instagram's buttons, in a few common languages.
const MUTE_LABEL = /audio|sound|mute|volume|\bses|\bton\b|\bson\b|sonido|áudio|suono|звук/i;
const NEXT_LABEL = /\bnext\b|sonraki|weiter|suivant|siguiente|avanti|próximo|далее/i;

const DEBUG = (() => {
  try {
    return localStorage.getItem('ivc-debug') === '1';
  } catch {
    return false;
  }
})();

function debug(...args: unknown[]): void {
  if (DEBUG) console.debug('[ivc]', ...args);
}

/** Last trusted click on Instagram's own UI (not our overlay). */
const pageClick = { time: -Infinity, target: null as Element | null };
window.addEventListener('click', (e) => {
  const target = e.composedPath()[0];
  // Clicks inside our closed shadow root are retargeted to the host element.
  if (!e.isTrusted || !(target instanceof Element) || target.localName === HOST_TAG) return;
  pageClick.time = performance.now();
  pageClick.target = target;
}, { capture: true, passive: true });

export function isReelsPage(): boolean {
  return /^\/reels?\//.test(location.pathname);
}

export class VideoController {
  readonly host: HTMLElement;
  private readonly ui: ControlsUI;
  private readonly ac = new AbortController();

  private intersecting = false;
  private shown = false;
  private rect: DOMRect | null = null;
  private lastOcclusionCheck = 0;
  private occluded = false;

  private lastActivity = 0;
  private barHovered = false;
  private scrubbing = false;
  private scrubFraction = 0;
  private draggingVolume = false;

  private frameDuration = 1 / 30;
  private osdTimer: ReturnType<typeof setTimeout> | undefined;

  private fsTarget: HTMLElement | null = null;
  private fsSaved = { objectFit: '', background: '' };

  /** Mute state the user chose with our controls; Instagram is not allowed to change it behind our back. */
  private wantMuted: boolean | null = null;
  private lastMuted: boolean;
  private igMuteButton: WeakRef<HTMLElement> | null = null;

  /** Loop state the user chose with our controls, enforced over Instagram's own looping. */
  private loopOverride: boolean | null = null;
  private lastTime = 0;
  private lastOwnSeek = -Infinity;
  private lastOwnPlay = -Infinity;
  private endedAt = -Infinity;
  private advanced = false;

  // Cached render state so per-frame updates only touch the DOM when something changed.
  private lastTimeText = '';
  private lastPaused: boolean | null = null;

  constructor(readonly video: HTMLVideoElement, private readonly ctx: ControllerHost) {
    this.lastMuted = video.muted;
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
    if (patch.autoNext !== undefined) this.ui.nextBtn.classList.toggle('on', patch.autoNext);
    this.renderSpeed();
  }

  // ---------- per-frame update, driven by the global rAF loop ----------

  frame(now: number): void {
    if (!this.intersecting) return;
    this.checkEnd();
    const r = this.video.getBoundingClientRect();
    const isFs = this.isFullscreen;
    // Clamp to the viewport so the bar sits at the visible bottom of tall or partly scrolled videos.
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const visibleHeight = bottom - top;

    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT || visibleHeight < Math.min(MIN_HEIGHT, r.height)) {
      this.setShown(false, 'too small');
      return;
    }
    if (!isFs && now - this.lastOcclusionCheck > OCCLUSION_INTERVAL) {
      this.lastOcclusionCheck = now;
      this.occluded = this.checkOccluded(r, bottom);
    }
    if (!isFs && this.occluded) {
      this.setShown(false, 'covered');
      return;
    }
    this.setShown(true, 'visible');

    this.rect = r;
    const s = this.host.style;
    s.left = `${r.left}px`;
    s.top = `${top}px`;
    s.width = `${r.width}px`;
    s.height = `${visibleHeight}px`;
    this.ui.speedMenu.style.setProperty('--menu-max', `${Math.max(120, visibleHeight - BAR_HEIGHT)}px`);

    const menuOpen = this.ui.speedMenu.classList.contains('open');
    const active =
      this.scrubbing || this.draggingVolume || this.barHovered || menuOpen ||
      this.video.paused || now - this.lastActivity < HIDE_DELAY;
    this.ui.wrap.classList.toggle('idle', !active);
    this.ui.wrap.classList.toggle('reels', isReelsPage());

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

  toggleLoop(): void {
    this.loopOverride = !this.loops;
    this.video.loop = this.loopOverride;
    this.renderLoop();
    this.flash(this.loopOverride ? 'Loop on' : 'Loop off');
  }

  toggleAutoNext(): void {
    const autoNext = !this.ctx.settings.autoNext;
    this.ctx.update({ autoNext });
    this.flash(autoNext ? 'Auto-next on' : 'Auto-next off');
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
    return this.loopOverride ?? this.video.loop;
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
      this.loopOverride = null;
      this.advanced = false;
      this.lastTime = 0;
    }, opts);
    video.addEventListener('loadedmetadata', () => this.trackFrameRate(), opts);
    video.addEventListener('volumechange', () => this.onVolumeChange(), opts);
    video.addEventListener('timeupdate', () => this.checkEnd(), opts);
    video.addEventListener('ended', () => {
      this.endedAt = performance.now();
      if (this.autoNextActive()) this.advance();
    }, opts);
    video.addEventListener('play', () => {
      // Instagram restarts reels itself after `ended`; respect "loop off".
      const restartedByInstagram = performance.now() - this.endedAt < 500 && performance.now() - this.lastOwnPlay > 500;
      if (this.loopOverride === false && restartedByInstagram) this.stopAtEnd();
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
    }
    ui.catcher.addEventListener('click', () => this.togglePlay(), opts);
    ui.bar.addEventListener('pointerenter', () => (this.barHovered = true), opts);
    ui.bar.addEventListener('pointerleave', () => (this.barHovered = false), opts);
    ui.bar.addEventListener('wheel', (e) => this.onWheel(e), { ...opts, passive: false });

    ui.playBtn.addEventListener('click', () => this.togglePlay(), opts);
    ui.muteBtn.addEventListener('click', () => this.toggleMute(), opts);
    ui.loopBtn.addEventListener('click', () => this.toggleLoop(), opts);
    ui.nextBtn.addEventListener('click', () => this.toggleAutoNext(), opts);
    ui.pipBtn.addEventListener('click', () => void this.togglePip(), opts);
    ui.fsBtn.addEventListener('click', () => void this.toggleFullscreen(), opts);

    ui.speedBtn.addEventListener('click', () => ui.speedMenu.classList.toggle('open'), opts);
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
      if (!e.composedPath().includes(ui.speedMenu.parentElement!)) this.closeMenu();
    }, { ...opts, capture: true });

    this.bindScrubbing();
    this.bindVolumeSlider();
  }

  private bindScrubbing(): void {
    const { progress, tip } = this.ui;
    const opts = { signal: this.ac.signal };
    const fractionAt = (clientX: number) => {
      const r = progress.getBoundingClientRect();
      return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    };

    // Seek without pausing: Instagram reacts to pause/play events (e.g. re-applying its own mute state).
    progress.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !Number.isFinite(this.video.duration)) return;
      progress.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      progress.classList.add('scrubbing');
      this.scrubFraction = fractionAt(e.clientX);
      this.seekTo(this.scrubFraction * this.video.duration);
    }, opts);

    progress.addEventListener('pointermove', (e) => {
      const fraction = fractionAt(e.clientX);
      tip.textContent = formatTime(fraction * this.video.duration);
      tip.style.left = `${clampTipX(fraction * progress.clientWidth, tip.offsetWidth, progress.clientWidth)}px`;
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

  private findInstagramMuteButton(): HTMLElement | null {
    const learned = this.igMuteButton?.deref();
    if (learned?.isConnected) return learned;
    for (let el = this.video.parentElement, depth = 0; el && el !== document.body && depth < 10; el = el.parentElement, depth++) {
      if (el.querySelectorAll('video').length > 1) break;
      for (const button of el.querySelectorAll<HTMLElement>('button, [role="button"]')) {
        if (labelsOf(button).some((l) => MUTE_LABEL.test(l))) return button;
      }
    }
    return null;
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

  // ---------- end of video: loop off and auto-next ----------

  private autoNextActive(): boolean {
    return this.ctx.settings.autoNext && isReelsPage() && !this.isFullscreen;
  }

  private checkEnd(): void {
    const { video } = this;
    if (this.loopOverride !== null && video.loop !== this.loopOverride) video.loop = this.loopOverride;
    const d = video.duration;
    const t = video.currentTime;
    const prev = this.lastTime;
    this.lastTime = t;
    if (!Number.isFinite(d) || d < 1 || this.scrubbing || video.paused) return;
    if (t < d - 1) this.advanced = false;
    // Instagram may restart the video between our checks; catch the jump from the end back to the start.
    const wrapped = prev > d - 1 && t < 1 && performance.now() - this.lastOwnSeek > 400;
    if (this.autoNextActive() && (t >= d - END_MARGIN || wrapped)) this.advance();
    else if (this.loopOverride === false && wrapped) this.stopAtEnd();
  }

  private stopAtEnd(): void {
    debug('loop off: stopping at end');
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

  // ---------- fullscreen ----------

  private onFullscreenChange(): void {
    const target = this.fsTarget;
    if (!target) return;
    if (document.fullscreenElement === target) {
      // Only the fullscreen element's subtree is rendered, so move the overlay inside it.
      this.fsSaved = { objectFit: this.video.style.objectFit, background: target.style.background };
      this.video.style.objectFit = 'contain';
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
    this.video.style.objectFit = this.fsSaved.objectFit;
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

    ui.played.style.transform = `scaleX(${fraction})`;
    ui.linePlayed.style.transform = `scaleX(${fraction})`;
    ui.buffered.style.transform = `scaleX(${bufferedFraction})`;
    ui.thumb.style.left = `${fraction * 100}%`;
    ui.progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  private renderTime(): void {
    const current = this.scrubbing ? this.scrubFraction * this.video.duration : this.video.currentTime;
    const text = `${formatTime(current)} / ${formatTime(this.video.duration)}`;
    if (text !== this.lastTimeText) {
      this.lastTimeText = text;
      this.ui.time.textContent = text;
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
    this.ui.loopBtn.classList.toggle('on', this.loops);
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

function clampTipX(x: number, tipWidth: number, trackWidth: number): number {
  const half = tipWidth / 2;
  return Math.min(Math.max(x, half), trackWidth - half);
}
