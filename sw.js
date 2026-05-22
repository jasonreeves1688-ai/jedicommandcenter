// ═══════════════════════════════════════════════════════════════
// Reeves HQ — Service Worker v40 (clean slate)
//
// Architecture:
//   PRIMARY:  Supabase Edge Function + pg_cron sends push from
//             the server — completely independent of this SW.
//
//   FALLBACK: In-app alarm loop fires when app IS open (desktop
//             or when push unreliable). Uses SCHEDULE_ALARMS msg.
//
//   ALWAYS:   Lock-screen "Mark Done", badge count.
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME   = 'command-center-v40';
const SUPABASE_URL = 'https://pfsuljwznlxbfpmifdir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmc3Vsand6bmx4YmZwbWlmZGlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5OTg5NTMsImV4cCI6MjA5MDU3NDk1M30.BkXTbM37WDPa4aHhPh7yNsaqIIMAHd6uMTYrTZXw2RI';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Push received — Edge Function sends the full payload ──────
self.addEventListener('push', event => {
  let p = { title:'🏠 Reeves HQ', body:'Tap to open.', tag:'reeves-hq', actions:[], data:{}, requireInteraction:false };
  if (event.data) {
    try { Object.assign(p, event.data.json()); } catch(e) { try { p.body = event.data.text(); } catch(e2){} }
  }
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body:p.body, tag:p.tag, icon:'/icon-192.svg', badge:'/icon-192.svg',
      vibrate:[150,80,150], actions:p.actions||[], data:p.data||{},
      requireInteraction:p.requireInteraction||false
    })
  );
});

// ── Notification click ─────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action = event.action, tag = event.notification.tag;
  const data = event.notification.data || {}, url = data.url || '/';

  // Lock-screen "Mark Done" for family task
  if (action && action.startsWith('done_ft_')) {
    const taskId = action.replace('done_ft_','');
    event.waitUntil(completeFamilyTaskFromSW(taskId).then(() => notifyClients({type:'TASK_COMPLETED_FROM_SW',taskId})));
    return;
  }

  // Dismiss-only — no app needed
  if (action === 'dismiss' || action === 'later' || action === 'skip') {
    notifyClients({type:'NOTIF_ACTION', action, tag});
    return;
  }

  // EOD "Done" — mark without opening
  if (action === 'done' && tag === 'eod') {
    notifyClients({type:'NOTIF_ACTION', action:'done', tag:'eod'});
    event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => {
      if (!clients.some(c => c.url.includes(self.location.origin))) return self.clients.openWindow(url);
    }));
    return;
  }

  // Map tag → deep-link
  const urlMap = {
    morning:'/?action=morning', nudge:'/?tab=people', overdue:'/?tab=commitments',
    midday:'/?tab=today', delegation:'/?tab=commitments', eod:'/?action=eod',
    'kids-prizes':'/?tab=kids', family_briefing:'/?tab=home-today',
    home_handoff:'/?tab=home-today', work_overdue:'/?tab=commitments', meeting_prep:'/?tab=cal'
  };
  let targetUrl = urlMap[tag] || url;
  if (url && url !== '/') targetUrl = url; // payload URL overrides default

  event.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.focus(); c.postMessage({type:'NOTIF_CLICK', action, tag, url:targetUrl}); return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

function notifyClients(msg) {
  self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => {
    clients.forEach(c => { if (c.url.includes(self.location.origin)) c.postMessage(msg); });
  });
}

// ── Complete task + commitment from lock screen ────────────────
async function completeFamilyTaskFromSW(taskId) {
  try {
    const stored = await caches.open('sw-auth').then(c => c.match('supabase-session'));
    if (!stored) { console.warn('[SW] No session'); return; }
    const { accessToken } = await stored.json();
    const h = {'Content-Type':'application/json','Authorization':`Bearer ${accessToken}`,'apikey':SUPABASE_KEY,'Prefer':'return=minimal'};
    const done = {done:true,completed_at:Date.now()};
    const doneCm = {status:'done',completed_at:String(Date.now())};
    await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/family_tasks?id=eq.${taskId}`,          {method:'PATCH',headers:h,body:JSON.stringify(done)}),
      fetch(`${SUPABASE_URL}/rest/v1/commitments?id=eq.${taskId}`,           {method:'PATCH',headers:h,body:JSON.stringify(doneCm)}),
      fetch(`${SUPABASE_URL}/rest/v1/commitments?id=eq.cm-ft-${taskId}`,     {method:'PATCH',headers:h,body:JSON.stringify(doneCm)}),
    ]);
    await self.registration.showNotification('✓ Task completed',{body:'Marked done from notification',tag:'task-done-confirm',icon:'/icon-192.svg',badge:'/icon-192.svg'});
  } catch(e) { console.error('[SW] completeFamilyTask error:',e); }
}

// ── Message handler ────────────────────────────────────────────
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type==='UPDATE_BADGE' && 'setAppBadge' in self.navigator) self.navigator.setAppBadge(d.count).catch(()=>{});
  if (d.type==='CLEAR_BADGE'  && 'clearAppBadge' in self.navigator) self.navigator.clearAppBadge().catch(()=>{});
  if (d.type==='STORE_SESSION') {
    caches.open('sw-auth').then(c => c.put('supabase-session', new Response(JSON.stringify({accessToken:d.accessToken}))));
  }
  if (d.type==='SCHEDULE_ALARMS') {
    alarmConfig = d.alarms || [];
    if (!alarmInterval) alarmInterval = setInterval(checkAlarms, 60*1000);
    checkAlarms();
  }
  if (d.type==='FIRE_NOTIF') {
    self.registration.showNotification(d.title, {
      body:d.body||'', tag:d.tag||'reeves-hq', icon:'/icon-192.svg', badge:'/icon-192.svg',
      vibrate:[150,80,150], actions:d.actions||[], data:{url:d.url||'/'},
      requireInteraction:d.requireInteraction||false
    }).catch(()=>{});
  }
});

// ── Fallback in-app alarm loop ─────────────────────────────────
let alarmInterval = null, alarmConfig = [];
const _firedToday = {};

function checkAlarms() {
  if (!alarmConfig.length) return;
  const now = new Date(), h = now.getHours(), m = now.getMinutes();
  const todayStr = now.toLocaleDateString('en-CA');
  for (const alarm of alarmConfig) {
    if (!alarm.title) continue;
    const key = `${alarm.tag}_${todayStr}`;
    if (_firedToday[key]) continue;
    if (alarm.day !== undefined && now.getDay() !== alarm.day) continue;
    if (h !== alarm.hour || m >= 10) continue;
    _firedToday[key] = true;
    self.registration.showNotification(alarm.title, {
      body:alarm.body||'', tag:alarm.tag, icon:'/icon-192.svg', badge:'/icon-192.svg',
      vibrate:[150,80,150], actions:alarm.actions||[], data:{url:alarm.url||'/'},
      requireInteraction:alarm.requireInteraction||false
    }).catch(()=>{});
  }
}
