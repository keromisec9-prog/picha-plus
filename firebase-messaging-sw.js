importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCJMclaAgp-fh-FunUxOvuC8VgKoyiF_7A',
  authDomain: 'picha-entertainment.firebaseapp.com',
  projectId: 'picha-entertainment',
  storageBucket: 'picha-entertainment.firebasestorage.app',
  messagingSenderId: '37619691033',
  appId: '1:37619691033:web:25c2443a7286275f44c488',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body, icon } = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(title || 'Picha+', {
    body: body || 'You have a new notification',
    icon: icon || '/icon-192.png',
    badge: '/icon-192.png',
    data,
    tag: data.tag || 'pichaplus-notif',
    renotify: true,
    actions: [{ action: 'open', title: 'Open' }],
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || 'https://pichaplus.netlify.app';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('pichaplus') && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE', url });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
