// ═══════════════════════════════════════════════════════════════
// Jason's Command Center — Service Worker v39
// Handles: push notifications, lock-screen task completion,
//          background badge updates, in-app alarm fallback
//
// Changes from v38 → v39:
//   • completeFamilyTaskFromSW() now also PATCHes the commitments
//     table (cm-ft-{id} and direct id) so closing a task from the
//     lock screen reflects immediately in the Work/Commitments view
//     when the app opens — no stale "open" rows left behind.
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME   = 'command-center-v39';
const SUPABASE_URL = 'https://pfsuljwznlxbfpmifdir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmc3Vsand6bmx4YmZwbWlmZGlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5OTg5NTMsImV4cCI6MjA5MDU3NDk1M30.BkXTbM37WDPa4aHhPh7yNsaqIIMAHd6uMTYrTZXw2RI';

// ── Install & activate ────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Push notification received ────────────────────────────────
self.addEventListener('push', event => {
  let payload = {
    title:   '🏠 Reeves HQ',
    body:    'Tap to open.',
    tag:     'reeves-hq',
    actions: [],
    data:    {}
  };

  if (event.data) {
    try { Object.assign(payload, event.data.json()); }
    catch (e) { try { payload.body = event.data.text(); } catch (e2) {} }
  }

  // Default actions per tag if not provided by server
  if (!payload.actions || !payload.actions.length) {
    const defaults = {
      family_briefing: [
        { action: 'open_family', title: 'Open Family 👨‍👩‍👧‍👦' },
        { action: 'dismiss',     title: 'Got it'               }
      ],
      work_overdue: [
        { action: 'open_tasks', title: 'See Tasks ⚡' },
        { action: 'later',      title: 'Later'        }
      ],
      home_handoff: [
        { action: 'open_family', title: 'Open Family' },
        { action: 'dismiss',     title: 'Noted'       }
      ],
      morning: [
        { action: 'open', title: 'Start ☀' },
        { action: 'skip', title: 'Skip'    }
      ],
      eod: [
        { action: 'close', title: 'Close Day 🌙' },
        { action: 'done',  title: 'Done ✓'       }
      ],
      meeting_prep: [
        { action: 'prep', title: 'Open Prep 📋' }
      ]
    };
    payload.actions = defaults[payload.tag] || [];
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body:    payload.body,
      tag:     payload.tag,
      icon:    '/icon-192.svg',
      badge:   '/icon-192.svg',
      vibrate: [150, 80, 150],
      actions: payload.actions,
      data:    payload.data || {},
      // requireInteraction keeps notification visible until acted on
      requireInteraction: ['family_briefing', 'home_handoff', 'work_overdue'].includes(payload.tag)
    })
  );
});

// ── Notification click / action handler ───────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const tag    = event.notification.tag;
  const data   = event.notification.data || {};
  const url    = data.url || '/';

  // ── "Mark Done" from lock screen for a single family task ──
  // Action format: done_ft_{taskId}
  if (action && action.startsWith('done_ft_')) {
    const taskId = action.replace('done_ft_', '');
    event.waitUntil(
      completeFamilyTaskFromSW(taskId).then(() => {
        // Notify app if it is open so it can update local state
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => {
            for (const client of clients) {
              if (client.url.includes(self.location.origin)) {
                client.postMessage({ type: 'TASK_COMPLETED_FROM_SW', taskId });
              }
            }
          });
      })
    );
    return;
  }

  // ── Dismiss / later — no app open needed ──────────────────
  if (action === 'dismiss' || action === 'later' || action === 'skip') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'NOTIF_ACTION', action, tag });
        }
      }
    });
    return;
  }

  // ── EOD done — mark without fully opening ────────────────
  if (action === 'done' && tag === 'eod') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'NOTIF_ACTION', action: 'done', tag: 'eod' });
          return;
        }
      }
      if (self.clients.openWindow) self.clients.openWindow(url);
    });
    return;
  }

  // ── Open app at correct deep-link URL ────────────────────
  let targetUrl = url;
  if (action === 'open_family' || tag === 'family_briefing' || tag === 'home_handoff') {
    targetUrl = '/?tab=home-today';
  } else if (action === 'open_tasks' || tag === 'work_overdue') {
    targetUrl = '/?tab=tasks';
  } else if (action === 'open' && tag === 'morning') {
    targetUrl = '/?action=morning';
  } else if (action === 'close' && tag === 'eod') {
    targetUrl = '/?action=eod';
  } else if (tag === 'meeting_prep') {
    targetUrl = '/?tab=cal';
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIF_CLICK', action, tag, url: targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// Complete a family task directly from the SW (lock-screen tap)
//
// v39 change: after marking family_tasks done we also PATCH the
// commitments table for both the direct ID and the cm-ft-{id}
// migrated ID.  This means the Work/Commitments view shows the
// task as closed the moment the app opens — no stale open row.
// ═══════════════════════════════════════════════════════════════
async function completeFamilyTaskFromSW(taskId) {
  try {
    // Retrieve the stored access token (put there by STORE_SESSION on login)
    const stored = await caches.open('sw-auth').then(c => c.match('supabase-session'));
    if (!stored) {
      console.warn('[SW] No session stored — cannot complete task from lock screen');
      return;
    }
    const { accessToken } = await stored.json();

    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'apikey':        SUPABASE_KEY,
      'Prefer':        'return=minimal'
    };
    const completedAt = Date.now();

    // ── 1. Patch family_tasks ──────────────────────────────────
    const ftRes = await fetch(
      `${SUPABASE_URL}/rest/v1/family_tasks?id=eq.${taskId}`,
      {
        method:  'PATCH',
        headers,
        body: JSON.stringify({ done: true, completed_at: completedAt })
      }
    );

    if (!ftRes.ok) {
      console.error('[SW] Failed to complete family_tasks row:', ftRes.status);
      // Still try commitments — don't bail out
    } else {
      console.log('[SW] family_tasks patched:', taskId);
    }

    // ── 2. Patch commitments — direct ID (if task was created  ─
    //       directly as a commitment, not via migration)
    const cmDirectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/commitments?id=eq.${taskId}`,
      {
        method:  'PATCH',
        headers,
        body: JSON.stringify({ status: 'done', completed_at: String(completedAt) })
      }
    );
    if (!cmDirectRes.ok && cmDirectRes.status !== 404) {
      console.warn('[SW] commitments direct PATCH status:', cmDirectRes.status);
    }

    // ── 3. Patch commitments — migrated ID (cm-ft-{taskId}) ───
    //       Migration creates rows with this prefix pattern
    const migratedId = `cm-ft-${taskId}`;
    const cmMigratedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/commitments?id=eq.${migratedId}`,
      {
        method:  'PATCH',
        headers,
        body: JSON.stringify({ status: 'done', completed_at: String(completedAt) })
      }
    );
    if (!cmMigratedRes.ok && cmMigratedRes.status !== 404) {
      console.warn('[SW] commitments migrated PATCH status:', cmMigratedRes.status);
    }

    console.log('[SW] Family task + commitments completed from lock screen:', taskId);

    // Show a brief confirmation notification
    await self.registration.showNotification('✓ Task completed', {
      body:  'Marked done from notification',
      tag:   'task-done-confirm',
      icon:  '/icon-192.svg',
      badge: '/icon-192.svg'
    });

  } catch (e) {
    console.error('[SW] completeFamilyTaskFromSW error:', e);
  }
}

// ── Message handler ───────────────────────────────────────────
self.addEventListener('message', event => {
  const { type, count, taskId, action, tag } = event.data || {};

  // Badge count updates
  if (type === 'UPDATE_BADGE') {
    if ('setAppBadge' in self.navigator) {
      self.navigator.setAppBadge(count).catch(() => {});
    }
  }

  if (type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }

  // App stores its Supabase access token here on login so the SW
  // can authenticate Supabase REST calls from the lock screen
  if (type === 'STORE_SESSION') {
    caches.open('sw-auth').then(cache => {
      cache.put(
        'supabase-session',
        new Response(JSON.stringify({ accessToken: event.data.accessToken }))
      );
    });
  }

  // In-app alarm scheduling (fallback when app is open and push
  // isn't available — e.g. desktop Safari without push permission)
  if (type === 'SCHEDULE_ALARMS') {
    alarmConfig = event.data.alarms;
    if (!alarmInterval) {
      alarmInterval = setInterval(checkAlarms, 60 * 1000);
    }
    checkAlarms(); // check immediately on registration
  }
});

// ── In-app alarm loop ─────────────────────────────────────────
// Fires when the app is open and the SW is active.
// Used as a fallback on platforms where scheduled push isn't
// reliable (desktop, some iOS versions).
let alarmInterval = null;
let alarmConfig   = null;
const _firedToday = {};

function checkAlarms() {
  if (!alarmConfig) return;

  const now   = new Date();
  const h     = now.getHours();
  const m     = now.getMinutes();
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD

  for (const alarm of alarmConfig) {
    if (!alarm.title) continue;

    const key = alarm.tag + '_' + today;
    if (_firedToday[key]) continue;

    // Optional day-of-week filter (0=Sunday … 6=Saturday)
    if (alarm.day !== undefined && now.getDay() !== alarm.day) continue;

    // Fire within the first 10 minutes of the alarm hour
    if (h === alarm.hour && m < 10) {
      _firedToday[key] = true;
      self.registration.showNotification(alarm.title, {
        body:    alarm.body    || '',
        tag:     alarm.tag,
        icon:    '/icon-192.svg',
        badge:   '/icon-192.svg',
        vibrate: [150, 80, 150],
        actions: alarm.actions || [],
        data:    { url: alarm.url || '/' }
      }).catch(() => {});
    }
  }
}
