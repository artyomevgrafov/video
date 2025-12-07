const CACHE_VERSION = 'v5';
const STATIC_CACHE = `lan-video-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `lan-video-dynamic-${CACHE_VERSION}`;
const IMAGE_CACHE = `lan-video-images-${CACHE_VERSION}`;

// Static assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/tv.html',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// External resources to cache
const EXTERNAL_ASSETS = [
  'https://unpkg.com/lucide@0.294.0/dist/umd/lucide.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// ============== INSTALL ==============
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[SW] Caching static assets');
      // Cache each asset individually to handle failures gracefully
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(e => console.log('[SW] Cache failed:', url))
        )
      );
    })
  );
  self.skipWaiting();
});

// ============== ACTIVATE ==============
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => {
          return key.startsWith('lan-video-') &&
                 key !== STATIC_CACHE &&
                 key !== DYNAMIC_CACHE &&
                 key !== IMAGE_CACHE;
        }).map((key) => {
          console.log('[SW] Removing old cache:', key);
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// ============== FETCH ==============
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-http(s) schemes (chrome-extension, etc)
  if (!url.protocol.startsWith('http')) return;

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip streaming endpoints - always network
  if (url.pathname.startsWith('/hls/') ||
      url.pathname.startsWith('/streams/') ||
      url.pathname.startsWith('/tv/remote') ||
      url.pathname.startsWith('/tv/events')) {
    return;
  }

  // API calls - network first, no cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tv/')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        }))
    );
    return;
  }

  // Images - cache first, then network
  if (event.request.destination === 'image' || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(IMAGE_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => {
          // Return placeholder for failed images
          return new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // Static assets - cache first, update in background (stale-while-revalidate)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        // Only cache http(s) responses
        if (response.ok && url.protocol.startsWith('http')) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => {
            cache.put(event.request, clone).catch(() => {});
          });
        }
        return response;
      });

      return cached || fetchPromise.catch(() => {
        // Return offline page for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/offline.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ============== BACKGROUND SYNC ==============
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'send-to-tv') {
    event.waitUntil(
      getQueuedRequests().then((requests) => {
        return Promise.all(requests.map((req) => {
          return fetch('/tv/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req)
          }).then(() => removeFromQueue(req.id));
        }));
      })
    );
  }
});

// Queue management using IndexedDB
async function getQueuedRequests() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

async function removeFromQueue(id) {
  const db = await openDB();
  const tx = db.transaction('queue', 'readwrite');
  tx.objectStore('queue').delete(id);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lan-video-sw', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
    };
  });
}

// ============== PUSH NOTIFICATIONS ==============
self.addEventListener('push', (event) => {
  console.log('[SW] Push received');

  let data = { title: 'LAN Video', body: 'New notification' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: data.actions || [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    tag: data.tag || 'lan-video-notification',
    renotify: true,
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ============== NOTIFICATION CLICK ==============
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action);
  event.notification.close();

  if (event.action === 'dismiss') return;

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if available
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          client.postMessage({ type: 'notification-click', data: event.notification.data });
          return client.focus();
        }
      }
      // Open new window
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// ============== MESSAGE HANDLING ==============
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'QUEUE_REQUEST') {
    openDB().then((db) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({
        id: Date.now(),
        ...event.data.payload
      });
    });
  }

  if (event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }

  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => {
      Promise.all(keys.map((key) => caches.delete(key))).then(() => {
        event.ports[0].postMessage({ success: true });
      });
    });
  }
});

// ============== PERIODIC SYNC ==============
self.addEventListener('periodicsync', (event) => {
  console.log('[SW] Periodic sync:', event.tag);

  if (event.tag === 'update-tv-status') {
    event.waitUntil(
      fetch('/tv/clients')
        .then((res) => res.json())
        .then((data) => {
          if (data.clients > 0) {
            // Update badge
            if ('setAppBadge' in navigator) {
              navigator.setAppBadge(data.clients);
            }
          }
        })
        .catch(() => {})
    );
  }
});

// ============== SHARE TARGET ==============
self.addEventListener('fetch', (event) => {
  if (event.request.method === 'POST' && new URL(event.request.url).pathname === '/share') {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const url = formData.get('url') || formData.get('text') || '';

        // Redirect to main page with shared URL
        return Response.redirect(`/?shared=${encodeURIComponent(url)}`, 303);
      })()
    );
  }
});

console.log('[SW] Service Worker loaded, version:', CACHE_VERSION);
