const CACHE_NAME = 'picha-plus-v1';
const ASSETS = ['/picha-plus/','/picha-plus/index.html','/picha-plus/manifest.json','/picha-plus/icon-192.png','/picha-plus/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(caches.match(e.request).then(c => c || fetch(e.request))); });