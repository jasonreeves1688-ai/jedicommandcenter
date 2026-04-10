// ══════════════════════════════════════════════════════════════
// REEVES HQ — Service Worker v4
// Handles: push notifications, offline caching, badge updates
// ══════════════════════════════════════════════════════════════

const CACHE_NAME  = 'reeves-v4'
const SUPABASE_URL = 'https://pfsuljwznlxbfpmifdir.supabase.co'

// ── Install & activate ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['./', './index.html']).catch(() => {})
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// ── Offline fetch ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('googleapis') ||
      event.request.method !== 'GET') return

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone))
        }
        return res
      })
      .catch(() => caches.match(event.request).then(cached => {
        if (cached) return cached
        if (event.request.mode === 'navigate')
          return caches.match('./') || caches.match('./index.html')
        return new Response('Offline', { status: 503 })
      }))
  )
})

// ── Push notification received ────────────────────────────────
self.addEventListener('push', event => {
  console.log('[SW] Push received', event.data ? 'with data' : 'no data')

  let payload = {
    title:   '🏠 Reeves HQ',
    body:    'Tap to open.',
    tag:     'reeves-hq',
    actions: [],
    data:    {}
  }

  if (event.data) {
    try { Object.assign(payload, event.data.json()) }
    catch(e) {
      try { payload.body = event.data.text() } catch(e2) {}
    }
  }

  // Default actions per tag
  if (!payload.actions || !payload.actions.length) {
    const defaults = {
      family_briefing: [
        { action:'open_family', title:'Open Family 👨‍👩‍👧‍👦' },
        { action:'dismiss',     title:'Got it' }
      ],
      work_overdue: [
        { action:'open_tasks', title:'See Tasks ⚡' },
        { action:'later',      title:'Later' }
      ],
      home_handoff: [
        { action:'open_family', title:'Open Family' },
        { action:'dismiss',     title:'Noted' }
      ],
      morning: [
        { action:'open', title:'Start ☀' },
        { action:'skip', title:'Skip' }
      ],
      eod: [
        { action:'close', title:'Close Day 🌙' },
        { action:'done',  title:'Done ✓' }
      ],
      test: []
    }
    payload.actions = defaults[payload.tag] || []
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body:               payload.body,
      tag:                payload.tag,
      icon:               '/icon-192.png',
      badge:              '/icon-192.png',
      vibrate:            [150, 80, 150],
      actions:            payload.actions,
      data:               payload.data || {},
      requireInteraction: ['family_briefing','home_handoff','work_overdue'].includes(payload.tag)
    })
  )
})

// ── Notification click ────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close()

  const action = event.action
  const tag    = event.notification.tag
  const data   = event.notification.data || {}

  // Determine target URL
  let targetUrl = '/'
  if (action === 'open_family' || tag === 'family_briefing' || tag === 'home_handoff') {
    targetUrl = '/?tab=family'
  } else if (action === 'open_tasks' || tag === 'work_overdue') {
    targetUrl = '/?tab=tasks'
  } else if (tag === 'morning' || action === 'open') {
    targetUrl = '/?action=morning'
  } else if (tag === 'eod' || action === 'close') {
    targetUrl = '/?action=eod'
  }

  // Dismiss actions — no need to open app
  if (action === 'dismiss' || action === 'skip' || action === 'later') {
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin))
          client.postMessage({ type:'NOTIF_ACTION', action, tag })
      }
    })
    return
  }

  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus()
          client.postMessage({ type:'NOTIF_CLICK', action, tag, url:targetUrl })
          return
        }
      }
      // Open new window
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
    })
  )
})

// ── App messages ──────────────────────────────────────────────
self.addEventListener('message', event => {
  const { type, count } = event.data || {}

  if (type === 'UPDATE_BADGE') {
    if ('setAppBadge' in self.navigator)
      self.navigator.setAppBadge(count).catch(() => {})
  }

  if (type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator)
      self.navigator.clearAppBadge().catch(() => {})
  }

  // Store auth token for lock-screen task completion
  if (type === 'STORE_SESSION') {
    caches.open('sw-auth').then(cache =>
      cache.put('supabase-session',
        new Response(JSON.stringify({ accessToken: event.data.accessToken })))
    )
  }
})

// ── Complete family task from lock screen ─────────────────────
async function completeFamilyTaskFromSW(taskId) {
  try {
    const stored = await caches.open('sw-auth').then(c => c.match('supabase-session'))
    if (!stored) return
    const { accessToken } = await stored.json()

    await fetch(`${SUPABASE_URL}/rest/v1/family_tasks?id=eq.${taskId}`, {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'apikey':        'sb_publishable_26IDRbgOEzYuDYIO2Ty6xQ_1aUBIx--',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({ done:true, completed_at:Date.now() })
    })

    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const client of clients)
        if (client.url.includes(self.location.origin))
          client.postMessage({ type:'TASK_COMPLETED_FROM_SW', taskId })
    })
  } catch(e) {
    console.error('[SW] completeFamilyTask error:', e)
  }
}
