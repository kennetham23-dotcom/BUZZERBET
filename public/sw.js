// ─────────────────────────────────────────────
//  BuzzerBet Service Worker  v1.0.0
//  Handles: caching, offline, push notifications,
//           background sync, periodic sync
// ─────────────────────────────────────────────

const SW_VERSION   = 'buzzerbet-v1.0.0';
const STATIC_CACHE = `${SW_VERSION}-static`;
const API_CACHE    = `${SW_VERSION}-api`;
const IMG_CACHE    = `${SW_VERSION}-images`;

// Assets to pre-cache on install
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
];

// ── INSTALL ──────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing', SW_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating', SW_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('buzzerbet-') && k !== STATIC_CACHE && k !== API_CACHE && k !== IMG_CACHE)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser extensions
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── API calls: Network first, fallback to cache ──
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // ── Socket.io: Never intercept ──
  if (url.pathname.startsWith('/socket.io/')) return;

  // ── Images: Cache first ──
  if (request.destination === 'image') {
    event.respondWith(cacheFirstImages(request));
    return;
  }

  // ── App shell & static: Stale-while-revalidate ──
  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirstAPI(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      // Only cache safe, non-sensitive endpoints
      const url = new URL(request.url);
      const cacheable = ['/api/games/leaderboard', '/api/auth/profile'];
      if (cacheable.some(p => url.pathname.startsWith(p))) {
        cache.put(request, response.clone());
      }
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response(
      JSON.stringify({ error: 'You are offline', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstImages(request) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 404 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || caches.match('/offline.html');
}

// ── PUSH NOTIFICATIONS ────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'BuzzerBet', body: event.data.text() }; }

  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    image: data.image || null,
    tag: data.tag || 'buzzerbet-notification',
    renotify: true,
    requireInteraction: data.requireInteraction || false,
    vibrate: [100, 50, 100],
    timestamp: Date.now(),
    actions: data.actions || [],
    data: {
      url: data.url || '/',
      type: data.type || 'general',
      ...data.payload,
    },
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'BuzzerBet', options)
  );
});

// ── NOTIFICATION CLICK ────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { url, type } = event.notification.data;
  const targetUrl = event.action === 'play' ? '/?action=quickplay' : (url || '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', notificationType: type, url: targetUrl });
          return client.focus();
        }
      }
      // Open new window
      return clients.openWindow(targetUrl);
    })
  );
});

// ── BACKGROUND SYNC ───────────────────────────
// Queues failed requests (e.g. taps during brief disconnect) and retries
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'sync-game-taps') {
    event.waitUntil(syncGameTaps());
  }
  if (event.tag === 'sync-deposit') {
    event.waitUntil(syncPendingDeposits());
  }
});

async function syncGameTaps() {
  // In production, read queued taps from IndexedDB and POST to server
  // This ensures taps during a brief reconnect aren't lost
  const db = await openDB();
  const taps = await getAllFromStore(db, 'pendingTaps');
  for (const tap of taps) {
    try {
      await fetch('/api/games/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tap.token}` },
        body: JSON.stringify({ gameId: tap.gameId, count: tap.count }),
      });
      await deleteFromStore(db, 'pendingTaps', tap.id);
    } catch {
      console.log('[SW] Sync failed, will retry');
    }
  }
}

async function syncPendingDeposits() {
  const db = await openDB();
  const deposits = await getAllFromStore(db, 'pendingDeposits');
  for (const dep of deposits) {
    try {
      await fetch('/api/payments/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dep.token}` },
        body: JSON.stringify(dep.payload),
      });
      await deleteFromStore(db, 'pendingDeposits', dep.id);
    } catch {
      console.log('[SW] Deposit sync failed, will retry');
    }
  }
}

// ── PERIODIC BACKGROUND SYNC ──────────────────
// Refreshes balance/notifications while app is in background
self.addEventListener('periodicsync', event => {
  if (event.tag === 'refresh-balance') {
    event.waitUntil(refreshBalance());
  }
});

async function refreshBalance() {
  try {
    const allClients = await clients.matchAll();
    for (const client of allClients) {
      client.postMessage({ type: 'REFRESH_BALANCE' });
    }
  } catch (err) {
    console.log('[SW] Periodic sync error:', err);
  }
}

// ── MESSAGE HANDLER ───────────────────────────
// Receives messages from the main app
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (type === 'CACHE_URLS') {
    caches.open(STATIC_CACHE).then(cache => cache.addAll(payload.urls));
  }

  if (type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});

// ── INDEXEDDB HELPERS ─────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('buzzerbet-sw', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pendingTaps'))
        db.createObjectStore('pendingTaps', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('pendingDeposits'))
        db.createObjectStore('pendingDeposits', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function deleteFromStore(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
