// Offscreen page: the background worker can't create blob: URLs itself,
// so it sends image bytes here and gets back a URL that chrome.downloads can save.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'makeBlobUrl') {
    const bin = atob(msg.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: msg.mime || 'application/octet-stream' }));
    sendResponse({ url });
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.url);
    sendResponse({ ok: true });
  }
});
