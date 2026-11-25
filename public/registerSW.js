if (
  'serviceWorker' in navigator &&
  window.location.hostname !== 'appassets.androidplatform.net' &&
  window.location.protocol !== 'file:'
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        // Ignore registration errors in restricted preview iframes
      });
  });
}
