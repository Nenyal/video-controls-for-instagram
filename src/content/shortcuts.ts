import { isStoriesPage, type VideoController } from './controller';
import type { Settings } from '../shared/settings';

export interface ActiveVideo {
  controller: VideoController;
  hovered: boolean;
}

/**
 * YouTube-style keyboard shortcuts. Handled on window in the capture phase so they run before
 * Instagram's own key handlers; events are only swallowed when a shortcut actually fires.
 */
export function installShortcuts(
  getSettings: () => Settings,
  getActive: () => ActiveVideo | null,
  signal: AbortSignal,
): void {
  window.addEventListener('keydown', (e) => {
    const settings = getSettings();
    // Untrusted events include our own synthetic arrow keys used to navigate to the next reel.
    if (!e.isTrusted || !settings.shortcuts || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTyping(e)) return;
    const active = getActive();
    if (!active) return;
    const c = active.controller;
    const step = settings.seekStep;

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        c.togglePlay();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        // On stories the arrows keep switching stories; the bar has ±5s buttons instead.
        if (isStoriesPage()) return;
        c.seekBy(e.key === 'ArrowLeft' ? -step : step);
        break;
      case 'j':
      case 'J':
        c.seekBy(-10);
        break;
      case 'l':
      case 'L':
        c.seekBy(10);
        break;
      case '<':
        c.stepSpeed(-1);
        break;
      case '>':
        c.stepSpeed(1);
        break;
      case 'm':
      case 'M':
        c.toggleMute();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        // Only when hovering, so arrow keys keep scrolling the page/reels otherwise.
        if (!active.hovered) return;
        c.changeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05);
        break;
      case 'f':
      case 'F':
        void c.toggleFullscreen();
        break;
      case 'p':
      case 'P':
        void c.togglePip();
        break;
      case 'r':
      case 'R':
        c.cycleEndMode();
        break;
      case 'd':
      case 'D':
        void c.download();
        break;
      case ',':
        c.stepFrame(-1);
        break;
      case '.':
        c.stepFrame(1);
        break;
      default:
        if (!/^[0-9]$/.test(e.key)) return;
        c.seekToFraction(Number(e.key) / 10);
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true, signal });
}

function isTyping(e: KeyboardEvent): boolean {
  const target = (e.composedPath()[0] ?? document.activeElement) as Element | null;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(target.type);
  }
  return target.getAttribute('role') === 'textbox';
}
