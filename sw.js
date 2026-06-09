'use strict';

const alarmTimers = new Map();

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'SCHEDULE') {
    alarmTimers.forEach(tid => clearTimeout(tid));
    alarmTimers.clear();

    const now = Date.now();
    (msg.alarms || []).forEach(alarm => {
      const delay = alarm.fireAt - now;
      if (delay <= 0) return;
      const tid = setTimeout(() => {
        self.registration.showNotification(alarm.title, {
          body: alarm.body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: alarm.id,
          renotify: false,
          data: { url: self.location.origin }
        });
        alarmTimers.delete(alarm.id);
      }, delay);
      alarmTimers.set(alarm.id, tid);
    });
  }

  if (msg.type === 'CANCEL_ALL') {
    alarmTimers.forEach(tid => clearTimeout(tid));
    alarmTimers.clear();
  }

  if (msg.type === 'CANCEL') {
    const tid = alarmTimers.get(msg.id);
    if (tid !== undefined) {
      clearTimeout(tid);
      alarmTimers.delete(msg.id);
    }
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
