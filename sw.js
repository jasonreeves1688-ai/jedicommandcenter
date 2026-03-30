// ═══════════════════════════════════════════════════════════════
// Jason's Command Center — Service Worker v37
// Handles: push notifications (both server-sent VAPID + in-app alarms)
//          background badge updates
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'command-center-v38'; // ← bump to force SW update on all devices

// ── Install: skip waiting, activate immediately ──────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
});

// ── Activate: claim clients, clear old caches ───────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== 'sw-store-v1') // keep the alarm store cache
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: pass-through — no HTML caching ───────────────────────
self.addEventListener('fetch', event => {
  return; // always network
});

// ── Push: handle server-sent VAPID push notifications ───────────
// Payload from Apps Script (Code.gs sendWebPush):
// { title, body, tag, url, icon, badge, vibrate, actions? }
self.addEventListener('push', event => {
  let data = {
    title:   '⚔ Command Center',
    body:    'Tap to open.',
    tag:     'command-center',
    url:     '/',
    icon:    '/icon-192.svg',
    badge:   '/icon-192.svg',
    vibrate: [200, 100, 200]
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      Object.assign(data, parsed);
    } catch(e) {
      try { data.body = event.data.text(); } catch(e2) {}
    }
  }

  // Default action buttons per tag if not provided in payload
  const defaultActions = {
    morning: [{ action: 'open', title: '☀ Open Today' }, { action: 'skip', title: 'Skip' }],
    midday:  [{ action: 'open', title: '⚔ Check in'  }, { action: 'later', title: 'Later' }],
    eod:     [{ action: 'open', title: '🌙 Close day' }, { action: 'done',  title: 'Done ✓' }],
    nudge:   [{ action: 'open', title: '👥 See contacts' }, { action: 'later', title: 'Later' }],
  };

  const actions = data.actions || defaultActions[data.tag] || [
    { action: 'open', title: 'Open App' },
    { action: 'dismiss', title: 'Dismiss' }
  ];

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon  || '/icon-192.svg',
      badge:   data.badge || '/icon-192.svg',
      tag:     data.tag,
      data:    { tag: data.tag, url: data.url || '/' },
      vibrate: data.vibrate || [200, 100, 200],
      actions: actions,
      requireInteraction: data.tag === 'morning' || data.tag === 'eod'
    })
  );
});

// ── Notification click: open app at the correct deep link ────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const tag    = event.notification.tag;
  const data   = event.notification.data || {};
  const url    = data.url || '/';

  // Dismissive actions — tell app to mark as handled, don't open
  if (action === 'skip' || action === 'later' || action === 'dismiss') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'NOTIF_ACTION', action, tag });
        }
      }
    });
    return;
  }

  // 'done' on EOD — mark done without opening if app is open
  if (action === 'done' && tag === 'eod') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'NOTIF_ACTION', action, tag });
          return;
        }
      }
      // App not open — open it so the action can be handled
      if (self.clients.openWindow) self.clients.openWindow(url);
    });
    return;
  }

  // All other actions (open, default tap) → open/focus app at the correct URL
  // For server-sent push, url carries the deep link from Code.gs payload
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // If app is already open, focus it and post navigation message
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIF_CLICK', action, tag, url });
          return;
        }
      }
      // App not open — open at the deep link URL
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

// ── In-app alarm loop (fires when app is open or SW active) ──────
// The app posts SCHEDULE_ALARMS on load. SW stores config and
// checks every minute. This is the fallback for when VAPID push
// isn't set up yet, or as a supplement to server-sent push.

let alarmInterval = null;
let alarmConfig   = null;

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SCHEDULE_ALARMS') {
    alarmConfig = event.data.alarms;
    startAlarmLoop();
  }
  if (event.data.type === 'UPDATE_BADGE') updateBadge(event.data.count);
  if (event.data.type === 'CLEAR_BADGE')  clearBadge();
});

function startAlarmLoop() {
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = setInterval(checkAlarms, 60 * 1000);
  checkAlarms();
}

async function checkAlarms() {
  if (!alarmConfig) return;
  const now     = new Date();
  const h       = now.getHours();
  const m       = now.getMinutes();
  const dateStr = now.toISOString().slice(0, 10);

  for (const alarm of alarmConfig) {
    if (h !== alarm.hour) continue;
    if (m > 10) continue; // only fire in first 10 min of the hour

    const firedKey    = 'alarm-fired-' + alarm.tag + '-' + dateStr;
    const alreadyFired = await getStore(firedKey);
    if (alreadyFired) continue;

    let shouldFire = false;
    if (alarm.tag === 'morning') {
      const done = await getStore('hub-morning-done');
      shouldFire = done !== dateStr;
    } else if (alarm.tag === 'overdue') {
      shouldFire = (alarm.overdueCount || 0) > 0;
    } else if (alarm.tag === 'eod') {
      const done = await getStore('hub-eod-done');
      shouldFire = done !== dateStr;
    } else if (alarm.tag === 'nudge') {
      shouldFire = (alarm.nudgeCount || 0) > 0 && !!alarm.title;
    } else if (alarm.tag === 'kids-prizes') {
      shouldFire = (alarm.unclaimedCount || 0) > 0;
    }

    if (shouldFire) {
      await setStore(firedKey, 'yes');
      await self.registration.showNotification(alarm.title, {
        body:    alarm.body,
        icon:    '/icon-192.svg',
        badge:   '/icon-192.svg',
        tag:     alarm.tag,
        vibrate: [200, 100, 200],
        data:    { tag: alarm.tag, url: '/' }
      });
    }
  }
}

// ── Badge API ────────────────────────────────────────────────────
function updateBadge(count) {
  if ('setAppBadge' in self.navigator) {
    self.navigator.setAppBadge(count).catch(() => {});
  }
}
function clearBadge() {
  if ('clearAppBadge' in self.navigator) {
    self.navigator.clearAppBadge().catch(() => {});
  }
}

// ── Key-value store via Cache API (survives SW restart) ──────────
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
