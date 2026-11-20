import { VideoController, type ControllerHost } from './controller';
import { installShortcuts, type ActiveVideo } from './shortcuts';
import { installImageDownloads } from './images';
import {
  DEFAULTS, createDebouncedSaver, loadSettings, onSettingsChanged, type Settings,
} from '../shared/settings';

const controllers = new Map<HTMLVideoElement, VideoController>();
const intersecting = new Set<VideoController>();
const save = createDebouncedSaver();
const mouse = { x: -1, y: -1 };

let settings: Settings = { ...DEFAULTS };
let running: AbortController | null = null;
let mutationObserver: MutationObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;
let rafId = 0;
let scanTimer: ReturnType<typeof setTimeout> | undefined;

const host: ControllerHost = {
  get settings() {
    return settings;
  },
  update(patch) {
    applySettings(patch);
    save(patch);
  },
};

function applySettings(patch: Partial<Settings>): void {
  const wasEnabled = settings.enabled;
  settings = { ...settings, ...patch };
  if (settings.enabled !== wasEnabled) {
    if (settings.enabled) start();
    else stop();
    return;
  }
  for (const c of controllers.values()) c.applySettings(patch);
}

// ---------- discovery ----------

function scheduleScan(): void {
  if (scanTimer !== undefined) return;
  scanTimer = setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, 150);
}

function scan(): void {
  for (const video of document.querySelectorAll('video')) {
    if (!controllers.has(video)) attach(video);
  }
  for (const video of controllers.keys()) {
    if (!video.isConnected) detach(video);
  }
}

function attach(video: HTMLVideoElement): void {
  const controller = new VideoController(video, host);
  controllers.set(video, controller);
  intersectionObserver?.observe(video);
}

function detach(video: HTMLVideoElement): void {
  const controller = controllers.get(video);
  if (!controller) return;
  intersectionObserver?.unobserve(video);
  intersecting.delete(controller);
  controller.destroy();
  controllers.delete(video);
}

// ---------- frame loop: positions overlays and updates progress for on-screen videos ----------

function ensureLoop(): void {
  if (!rafId && intersecting.size > 0) rafId = requestAnimationFrame(tick);
}

function tick(now: number): void {
  rafId = 0;
  for (const c of intersecting) c.frame(now);
  ensureLoop();
}

// ---------- active video for shortcuts ----------

function activeVideo(): ActiveVideo | null {
  let best: VideoController | null = null;
  let bestArea = 0;
  for (const c of intersecting) {
    if (!c.isShown) continue;
    if (c.isFullscreen) return { controller: c, hovered: true };
    if (c.hitTest(mouse.x, mouse.y)) return { controller: c, hovered: true };
    const area = c.visibleArea();
    if (area > bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best ? { controller: best, hovered: false } : null;
}

// ---------- start / stop ----------

function start(): void {
  if (running) return;
  running = new AbortController();
  const { signal } = running;

  intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const c = controllers.get(entry.target as HTMLVideoElement);
      if (!c) continue;
      c.setIntersecting(entry.isIntersecting);
      if (entry.isIntersecting) intersecting.add(c);
      else intersecting.delete(c);
    }
    ensureLoop();
  });

  mutationObserver = new MutationObserver(scheduleScan);
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    for (const c of intersecting) if (c.hitTest(e.clientX, e.clientY)) c.wake();
  }, { capture: true, passive: true, signal });

  installShortcuts(() => settings, activeVideo, signal);
  installImageDownloads(signal);
  scan();
}

function stop(): void {
  running?.abort();
  running = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
  intersectionObserver?.disconnect();
  intersectionObserver = null;
  clearTimeout(scanTimer);
  scanTimer = undefined;
  cancelAnimationFrame(rafId);
  rafId = 0;
  for (const video of [...controllers.keys()]) detach(video);
}

async function init(): Promise<void> {
  settings = await loadSettings();
  onSettingsChanged(applySettings);
  if (settings.enabled) start();
}

void init();
