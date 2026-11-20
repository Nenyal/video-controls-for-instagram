// Saves media files for the content script. Instagram's CDN is cross-origin, so a page-level
// <a download> would just open the file; chrome.downloads saves it.

interface DownloadMessage {
  type: 'download';
  url: string;
  filename: string;
}

chrome.runtime.onMessage.addListener((message: DownloadMessage, _sender, sendResponse) => {
  if (message?.type !== 'download') return false;
  chrome.downloads
    .download({ url: message.url, filename: message.filename, conflictAction: 'uniquify' })
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
  return true; // respond asynchronously
});
