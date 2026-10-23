/* Background delivery only. Never cache authenticated pages, API data or audio. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function localLink(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin && /^\/(doctor|patient)\//.test(url.pathname)) return url.href;
  } catch { /* Fall back to the authenticated home. */ }
  return self.location.origin + '/';
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Always show a visible notification. */ }
  const urgent = data.urgent === true;
  const options = {
    body: data.body || 'Откройте Рядом, чтобы посмотреть новое событие.',
    icon: '/icons/app-192.png', badge: '/icons/badge-96.png', lang: 'ru',
    tag: data.tag || 'ryadom-update', renotify: urgent, requireInteraction: urgent,
    data: {link: localLink(data.link), id: data.id},
    ...(urgent ? {vibrate: [250, 100, 250, 100, 500]} : {}),
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Рядом', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = localLink(event.notification.data?.link);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      const focused = await client.focus();
      await focused.navigate(link);
      return;
    }
    await self.clients.openWindow(link);
  })());
});
