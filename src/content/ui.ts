import { SPEEDS } from '../shared/settings';
import { formatSpeed } from '../shared/format';

// Material Design icon paths (Apache 2.0). Built with createElementNS rather than innerHTML
// because Instagram enforces Trusted Types, which can block HTML string sinks.
const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  volumeUp:
    'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volumeDown: 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
  volumeOff:
    'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
} as const;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function setIcon(button: HTMLButtonElement, name: IconName): void {
  button.querySelector('path')?.setAttribute('d', ICONS[name]);
}

function iconButton(name: IconName, label: string, className = ''): HTMLButtonElement {
  const button = el('button', `btn ${className}`.trim());
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  button.append(svg);
  return button;
}

export interface ControlsUI {
  wrap: HTMLDivElement;
  osd: HTMLDivElement;
  catcher: HTMLDivElement;
  line: HTMLDivElement;
  linePlayed: HTMLDivElement;
  bar: HTMLDivElement;
  progress: HTMLDivElement;
  buffered: HTMLDivElement;
  played: HTMLDivElement;
  thumb: HTMLDivElement;
  tip: HTMLDivElement;
  playBtn: HTMLButtonElement;
  time: HTMLSpanElement;
  muteBtn: HTMLButtonElement;
  volume: HTMLDivElement;
  volumeFill: HTMLDivElement;
  speedBtn: HTMLButtonElement;
  speedMenu: HTMLDivElement;
  speedItems: HTMLButtonElement[];
  loopBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  pipBtn: HTMLButtonElement;
  fsBtn: HTMLButtonElement;
}

export function buildUI(): ControlsUI {
  const wrap = el('div', 'wrap');
  const osd = el('div', 'osd');
  // Covers the video in fullscreen so clicks toggle playback instead of reaching Instagram's links.
  const catcher = el('div', 'catcher');

  const line = el('div', 'line');
  const linePlayed = el('div', 'line-played');
  line.append(linePlayed);

  const bar = el('div', 'bar');

  const progress = el('div', 'progress');
  progress.setAttribute('role', 'slider');
  progress.setAttribute('aria-label', 'Seek');
  const track = el('div', 'track');
  const buffered = el('div', 'buffered');
  const played = el('div', 'played');
  track.append(buffered, played);
  const thumb = el('div', 'thumb');
  const tip = el('div', 'tip');
  progress.append(track, thumb, tip);

  const row = el('div', 'row');
  const playBtn = iconButton('play', 'Play (k)');
  const time = el('span', 'time');
  const spacer = el('div', 'spacer');

  const muteBtn = iconButton('volumeUp', 'Mute (m)');
  const volume = el('div', 'volume');
  volume.setAttribute('role', 'slider');
  volume.setAttribute('aria-label', 'Volume');
  const volumeTrack = el('div', 'volume-track');
  const volumeFill = el('div', 'volume-fill');
  volumeTrack.append(volumeFill);
  volume.append(volumeTrack);
  const volumeGroup = el('div', 'volume-group');
  volumeGroup.append(muteBtn, volume);

  const speedWrap = el('div', 'speed-wrap');
  const speedBtn = el('button', 'btn speed');
  speedBtn.type = 'button';
  speedBtn.title = 'Playback speed (< / >)';
  const speedMenu = el('div', 'menu');
  speedMenu.setAttribute('role', 'menu');
  const speedItems = [...SPEEDS].reverse().map((speed) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.dataset.speed = String(speed);
    item.textContent = formatSpeed(speed);
    item.setAttribute('role', 'menuitemradio');
    return item;
  });
  speedMenu.append(...speedItems);
  speedWrap.append(speedBtn, speedMenu);

  const loopBtn = iconButton('loop', 'Loop (r)', 'toggle loop');
  const nextBtn = iconButton('next', 'Auto-play next reel (n)', 'toggle next');
  const pipBtn = iconButton('pip', 'Picture-in-picture (p)', 'toggle pip');
  const fsBtn = iconButton('fullscreen', 'Fullscreen (f)');

  row.append(playBtn, time, spacer, volumeGroup, speedWrap, loopBtn, nextBtn, pipBtn, fsBtn);
  bar.append(progress, row);
  wrap.append(catcher, osd, line, bar);

  return {
    wrap, osd, catcher, line, linePlayed, bar, progress, buffered, played, thumb, tip, playBtn, time,
    muteBtn, volume, volumeFill, speedBtn, speedMenu, speedItems, loopBtn, nextBtn, pipBtn, fsBtn,
  };
}
