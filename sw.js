// ═══════════════════════════════════════════════════════════════
// Jason's Command Center — Service Worker v38
// Handles: push notifications, lock-screen task completion,
//          background badge updates, in-app alarm fallback
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'command-center-v40';
const SUPABASE_URL = 'https://pfsuljwznlxbfpmifdir.supabase.co';

// ── Install & activate ────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
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
    catch(e) { try { payload.body = event.data.text(); } catch(e2) {} }
  }

  // Default actions per tag if not provided by server
  if (!payload.actions || !payload.actions.length) {
    const defaults = {
      family_briefing: [
        { action:'open_family', title:'Open Family 👨‍👩‍👧‍👦' },
        { action:'dismiss',     title:'Got it'               }
      ],
      work_overdue: [
        { action:'open_tasks', title:'See Tasks ⚡' },
        { action:'later',      title:'Later'        }
      ],
      home_handoff: [
        { action:'open_family', title:'Open Family' },
        { action:'dismiss',     title:'Noted'       }
      ],
      morning: [
        { action:'open', title:'Start ☀' },
        { action:'skip', title:'Skip'    }
      ],
      eod: [
        { action:'close', title:'Close Day 🌙' },
        { action:'done',  title:'Done ✓'       }
      ],
      meeting_prep: [
        { action:'prep', title:'Open Prep 📋' }
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
      requireInteraction: ['family_briefing','home_handoff','work_overdue'].includes(payload.tag)
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
        // Try to refresh app if open, otherwise silent
        return self.clients.matchAll({ type:'window', includeUncontrolled:true })
          .then(clients => {
            for (const client of clients) {
              if (client.url.includes(self.location.origin)) {
                client.postMessage({ type:'TASK_COMPLETED_FROM_SW', taskId });
              }
            }
          });
      })
    );
    return;
  }

  // ── Dismiss / later — no app open needed ──────────────────
  if (action === 'dismiss' || action === 'later' || action === 'skip') {
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type:'NOTIF_ACTION', action, tag });
        }
      }
    });
    return;
  }

  // ── EOD done — mark without fully opening ────────────────
  if (action === 'done' && tag === 'eod') {
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({ type:'NOTIF_ACTION', action:'done', tag:'eod' });
          return;
        }
      }
      if (self.clients.openWindow) self.clients.openWindow(url);
    });
    return;
  }

  // ── Open app at correct deep-link URL ────────────────────
  // Determine target URL based on action
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
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type:'NOTIF_CLICK', action, tag, url:targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// ── Complete a family task directly from the SW ───────────────
// Called when user taps "Mark Done" from lock screen notification.
// Uses Supabase REST API directly — no app needed to be open.
async function completeFamilyTaskFromSW(taskId) {
  try {
    // We need the service role key to bypass RLS from SW context.
    // We store it in a SW cache key set during app boot.
    const stored = await caches.open('sw-auth').then(c => c.match('supabase-session'));
    if (!stored) {
      console.warn('[SW] No session stored — cannot complete task from lock screen');
      return;
    }
    const { accessToken } = await stored.json();

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/family_tasks?id=eq.${taskId}`,
      {
        method:  'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey':        'sb_publishable_26IDRbgOEzYuDYIO2Ty6xQ_1aUBIx--',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({
          done:         true,
          completed_at: Date.now()
        })
      }
    );

    if (res.ok) {
      console.log('[SW] Family task completed from lock screen:', taskId);
      // Show confirmation notification
      await self.registration.showNotification('✓ Task completed', {
        body:  'Marked done from notification',
        tag:   'task-done-confirm',
        icon:  '/icon-192.svg',
        badge: '/icon-192.svg'
      });
    } else {
      console.error('[SW] Failed to complete task:', res.status);
    }
  } catch(e) {
    console.error('[SW] completeFamilyTaskFromSW error:', e);
  }
}

// ── Badge update ──────────────────────────────────────────────
self.addEventListener('message', event => {
  const { type, count, taskId, action, tag } = event.data || {};

  if (type === 'UPDATE_BADGE') {
    if ('setAppBadge' in self.navigator) self.navigator.setAppBadge(count).catch(()=>{});
  }
  if (type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge().catch(()=>{});
  }

  // App storing its auth token so SW can complete tasks from lock screen
  if (type === 'STORE_SESSION') {
    caches.open('sw-auth').then(cache => {
      cache.put('supabase-session', new Response(JSON.stringify({ accessToken: event.data.accessToken })));
    });
  }

  // In-app alarm scheduling (fallback when app is open)
  if (type === 'SCHEDULE_ALARMS') {
    alarmConfig = event.data.alarms;
    if (!alarmInterval) {
      alarmInterval = setInterval(checkAlarms, 60 * 1000);
    }
    checkAlarms();
  }
});

// ── In-app alarm loop (fallback, fires when app is open) ──────
let alarmInterval = null;
let alarmConfig   = null;
const _firedToday = {};

function checkAlarms() {
  if (!alarmConfig) return;
  const now    = new Date();
  const h      = now.getHours();
  const m      = now.getMinutes();
  const today  = now.toLocaleDateString('en-CA');

  for (const alarm of alarmConfig) {
    if (!alarm.title) continue;
    const key = alarm.tag + '_' + today;
    if (_firedToday[key]) continue;
    if (alarm.day !== undefined && now.getDay() !== alarm.day) continue;
    if (h === alarm.hour && m < 10) {
      _firedToday[key] = true;
      self.registration.showNotification(alarm.title, {
        body:    alarm.body || '',
        tag:     alarm.tag,
        icon:    '/icon-192.svg',
        badge:   '/icon-192.svg',
        vibrate: [150,80,150],
        actions: alarm.actions || [],
        data:    { url: alarm.url || '/' }
      }).catch(() => {});
    }
  }
}
