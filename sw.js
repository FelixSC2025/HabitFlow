'use strict';

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAcopCVomQKm8lh9ZlptkDfREDAlysKeFo",
  authDomain: "habitflow-2b0dd.firebaseapp.com",
  projectId: "habitflow-2b0dd",
  storageBucket: "habitflow-2b0dd.firebasestorage.app",
  messagingSenderId: "169155002133",
  appId: "1:169155002133:web:f11a02fb1b93197787731c"
});

const messaging = firebase.messaging();

// Background push (app closed / tab not active)
messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const d = payload.data || {};
  self.registration.showNotification(n.title || d.title || '⭐ HabitFlow', {
    body: n.body || d.body || 'Zeit für deine Gewohnheit!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.habitId || 'habit',
    renotify: false,
    data: { url: d.url || self.location.origin }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
