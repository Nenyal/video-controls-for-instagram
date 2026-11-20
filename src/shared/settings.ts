/** What happens when a reel ends on reels pages. */
export type ReelsEnd = 'loop' | 'next' | 'stop';

export interface Settings {
  enabled: boolean;
  /** Playback speed applied to every video; remembered globally. */
  speed: number;
  volume: number;
  shortcuts: boolean;
  /** Seconds skipped by ←/→. */
  seekStep: number;
  /** Keep a thin progress line visible while the bar is hidden. */
  progressLine: boolean;
  reelsEnd: ReelsEnd;
}

export const DEFAULTS: Settings = {
  enabled: true,
  speed: 1,
  volume: 1,
  shortcuts: true,
  seekStep: 5,
  progressLine: true,
  reelsEnd: 'loop',
};

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    await chrome.storage.sync.set(patch);
  } catch {
    // Extension was reloaded or updated; this page's context is gone.
  }
}

/** Batches rapid writes (volume drags, repeated speed keys) to stay under storage.sync quotas. */
export function createDebouncedSaver(delay = 400): (patch: Partial<Settings>) => void {
  let pending: Partial<Settings> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (patch) => {
    pending = { ...pending, ...patch };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = pending;
      pending = {};
      void saveSettings(batch);
    }, delay);
  };
}

export function onSettingsChanged(callback: (patch: Partial<Settings>) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch: Record<string, unknown> = {};
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) patch[key] = change.newValue ?? DEFAULTS[key as keyof Settings];
    }
    if (Object.keys(patch).length > 0) callback(patch as Partial<Settings>);
  });
}
