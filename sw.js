// ═══════════════════════════════════════════════════════════════
// Jason's Command Center — Service Worker
// Handles: push notifications, background alarms, offline cache,
//          app badge updates
// ═══════════════════════════════════════════════════════════════
//
// ┌─────────────────────────────────────────────────────────────┐
// │  DEPLOY CHECKLIST                                           │
// │  Every time you update index.html, bump the version below:  │
// │  v1 → v2 → v3 etc.                                         │
// │  This tells installed apps to fetch the latest version.     │
// └─────────────────────────────────────────────────────────────┘

const CACHE_NAME = 'command-center-v8'; // ← BUMP THIS ON EVERY DEPLOY
const APP_SHELL = ['/'];

// ── Install: cache the app shell ────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ──────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ───────────────
self.addEventListener('fetch', event => {
  // Only cache same-origin GET requests
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const fresh = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fresh;
    })
  );
});

// ── Push: handle server-sent push notifications ─────────────────
// (Used when you set up a VAPID push server later)
self.addEventListener('push', event => {
  let data = { title: '⚔ Command Center', body: 'You have an update.' };
  try { data = event.data.json(); } catch(e) {
    try { data.body = event.data.text(); } catch(e2) {}
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon    || '/icon-192.svg',
      badge:   data.badge   || '/icon-192.svg',
      tag:     data.tag     || 'command-center',
      data:    { tag: data.tag, url: data.url || '/' },
      vibrate: [150, 80, 150],
      actions: data.actions || [
        { action: 'open',    title: 'Open App' },
        { action: 'dismiss', title: 'Dismiss'  }
      ]
    })
  );
});

// ── Notification click: open/focus the app ──────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const tag    = event.notification.tag;
  const data   = event.notification.data || {};
  const url    = data.url || '/';

  // Action button: skip morning — just dismiss, mark done via message
  if (action === 'skip' || action === 'later' || action === 'done') {
    // Tell app to mark the ritual/eod as skipped for today if open
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'NOTIF_ACTION', action, tag });
        }
      }
    });
    return;
  }

  // All other actions (open, focus, close, default tap) → open/focus app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIF_CLICK', action, tag, url });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// ── Background Sync: fire alarm notifications when app is closed ─
// The app posts a 'SCHEDULE_ALARMS' message on load with today's
// alarm config. The SW stores it and fires at the right times.

let alarmInterval = null;
let alarmConfig   = null;

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_ALARMS') {
    alarmConfig = event.data.alarms;
    startAlarmLoop();
  }
  if (event.data && event.data.type === 'UPDATE_BADGE') {
    updateBadge(event.data.count);
  }
  if (event.data && event.data.type === 'CLEAR_BADGE') {
    clearBadge();
  }
});

function startAlarmLoop() {
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = setInterval(checkAlarms, 60 * 1000); // every minute
  checkAlarms(); // run immediately too
}

async function checkAlarms() {
  if (!alarmConfig) return;
  const now  = new Date();
  const h    = now.getHours();
  const m    = now.getMinutes();
  const dateStr = now.toISOString().slice(0, 10);

  for (const alarm of alarmConfig) {
    if (h !== alarm.hour) continue;
    if (m > 10) continue; // only fire in the first 10 min of the hour
    const firedKey = 'alarm-fired-' + alarm.tag + '-' + dateStr;
    const alreadyFired = await getStore(firedKey);
    if (alreadyFired) continue;

    // Check condition
    let shouldFire = false;
    if (alarm.tag === 'morning') {
      const done = await getStore('hub-morning-done');
      shouldFire = done !== dateStr;
    } else if (alarm.tag === 'overdue') {
      const od = alarm.overdueCount || 0;
      shouldFire = od > 0;
    } else if (alarm.tag === 'eod') {
      const done = await getStore('hub-eod-done');
      shouldFire = done !== dateStr;
    }

    if (shouldFire) {
      await setStore(firedKey, 'yes');
      await self.registration.showNotification(alarm.title, {
        body:    alarm.body,
        icon:    '/icon-192.svg',
        badge:   '/icon-192.svg',
        tag:     alarm.tag,
        vibrate: [200, 100, 200],
        data:    '/'
      });
    }
  }
}

// ── Badge API ────────────────────────────────────────────────────
function updateBadge(count) {
  if ('setAppBadge' in navigator) {
    navigator.setAppBadge(count).catch(() => {});
  }
}

function clearBadge() {
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
}

// ── Simple key-value store via Cache API (survives SW restart) ───
async function getStore(key) {
  try {
    const cache = await caches.open('sw-store-v1');
    const resp  = await cache.match('/__store__/' + key);
    if (!resp) return null;
    return await resp.text();
  } catch(e) { return null; }
}

async function setStore(key, value) {
  try {
    const cache = await caches.open('sw-store-v1');
    await cache.put('/__store__/' + key, new Response(String(value)));
  } catch(e) {}
}
