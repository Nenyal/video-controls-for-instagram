import { SPEEDS, loadSettings, saveSettings, type Settings } from '../shared/settings';
import { formatSpeed } from '../shared/format';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enabled = $<HTMLInputElement>('enabled');
const speed = $<HTMLSelectElement>('speed');
const seekStep = $<HTMLSelectElement>('seekStep');
const progressLine = $<HTMLInputElement>('progressLine');
const shortcuts = $<HTMLInputElement>('shortcuts');
const options = $<HTMLElement>('options');

for (const s of SPEEDS) speed.add(new Option(formatSpeed(s), String(s)));

function render(settings: Settings): void {
  enabled.checked = settings.enabled;
  speed.value = String(settings.speed);
  seekStep.value = String(settings.seekStep);
  progressLine.checked = settings.progressLine;
  shortcuts.checked = settings.shortcuts;
  options.classList.toggle('disabled', !settings.enabled);
}

const settings = await loadSettings();
render(settings);

function bind(input: HTMLInputElement | HTMLSelectElement, toPatch: () => Partial<Settings>): void {
  input.addEventListener('change', () => {
    const patch = toPatch();
    Object.assign(settings, patch);
    render(settings);
    void saveSettings(patch);
  });
}

bind(enabled, () => ({ enabled: enabled.checked }));
bind(speed, () => ({ speed: Number(speed.value) }));
bind(seekStep, () => ({ seekStep: Number(seekStep.value) }));
bind(progressLine, () => ({ progressLine: progressLine.checked }));
bind(shortcuts, () => ({ shortcuts: shortcuts.checked }));
