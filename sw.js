// 推播用的 Service Worker：只負責收通知、點通知打開 app；不做離線快取（避免手機卡在舊版）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'CRUFU', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'CRUFU 2027', {
    body: m.body || '', tag: m.tag || undefined, renotify: true,
    icon: 'icons/app-192.png', badge: 'icons/app-192.png',
    vibrate: [200, 100, 200, 100, 200],
    data: { url: m.url || './' },
  }));
});

// 點通知：有網址（例如導航）就開網址；否則切回已開著的 app，沒有就開新的
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    if (!url.startsWith(self.registration.scope)) return self.clients.openWindow(url);
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = list.find(c => c.url.startsWith(self.registration.scope));
    if (!w) return self.clients.openWindow(url);
    w.postMessage({ url });                    // app 已開著：把網址傳過去（例如 ?ot=run 要跳出切換定位的按鈕）
    return w.focus();
  })());
});
