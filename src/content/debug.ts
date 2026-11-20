// Diagnostics, enabled per browser with localStorage.setItem('ivc-debug', '1') on instagram.com.

const ENABLED = (() => {
  try {
    return localStorage.getItem('ivc-debug') === '1';
  } catch {
    return false;
  }
})();

export function debug(...args: unknown[]): void {
  // console.log rather than console.debug: debug-level messages are hidden by default in DevTools.
  if (ENABLED) console.log('[ivc]', ...args);
}
