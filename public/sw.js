const CACHE_NAME = 'rich-aroma-v4';
const ASSETS = [
    '/',
    '/index.html',
    '/js/localforage.min.js',
    '/offline-manager.js',
    '/src/pos/pos.html',
    '/src/kds/kds.html',
    '/src/timeclock/timeclock.html',
    '/src/scheduling/scheduling.html',
    '/src/inventory/inventory.html',
    '/src/kpis/kpis.html',
    '/src/loyalty/loyalty.html',
    '/src/rewards/teacher-portal.html',
    '/src/rewards/load-balance.html',
    '/src/creators/review.html',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// Install Event - Cache Assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[SW] Caching assets');
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate Event - Cleanup Old Caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys.map(key => {
                if (key !== CACHE_NAME) {
                    console.log('[SW] Removing old cache', key);
                    return caches.delete(key);
                }
            }));
        })
    );
    self.clients.claim();
});

// Fetch Event
self.addEventListener('fetch', event => {
    // API calls: Network Only
    if (event.request.url.includes('/api/')) {
        return; 
    }

    // HTML files: Network First
    if (event.request.headers.get('accept').includes('text/html')) {
        event.respondWith(
            fetch(event.request).then(networkResponse => {
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                });
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Static Assets: Cache First
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            return cachedResponse || fetch(event.request).then(networkResponse => {
                return caches.open(CACHE_NAME).then(cache => {
                    if (event.request.method === 'GET' && networkResponse.status === 200) {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                });
            });
        })
    );
});
