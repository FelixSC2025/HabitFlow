'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const fcm = admin.messaging();

// App-URL für Notification-Klick. Setze sie mit:
//   firebase functions:config:set app.url="https://deine-app.web.app"
const APP_URL = (functions.config().app || {}).url || 'https://habitflow-2b0dd.web.app';

// Läuft jede Minute und sendet FCM-Nachrichten für fällige Habits.
exports.sendHabitReminders = functions
  .region('us-central1')
  .pubsub.schedule('every 1 minutes')
  .onRun(async () => {
    const now = new Date();
    const HH  = String(now.getHours()).padStart(2, '0');
    const MM  = String(now.getMinutes()).padStart(2, '0');
    const timeStr  = `${HH}:${MM}`;
    const todayStr = now.toISOString().split('T')[0];

    const usersSnap = await db.collection('users').get();
    const sends = [];

    for (const userDoc of usersSnap.docs) {
      const uid     = userDoc.id;
      const userRef = db.collection('users').doc(uid);

      // Habits, die genau jetzt Erinnerung haben
      const habitsSnap = await userRef.collection('habits')
        .where('notifyAt', '==', timeStr)
        .get();
      if (habitsSnap.empty) continue;

      // Bereits erledigte Habits heute
      const compSnap = await userRef.collection('completions')
        .where('date', '==', todayStr)
        .where('completed', '==', true)
        .get();
      const doneIds = new Set(compSnap.docs.map(d => d.data().habitId));

      // FCM-Tokens des Users
      const tokensSnap = await userRef.collection('fcmTokens').get();
      if (tokensSnap.empty) continue;
      const tokenDocs = tokensSnap.docs;
      const tokens    = tokenDocs.map(d => d.data().token).filter(Boolean);
      if (!tokens.length) continue;

      for (const habitDoc of habitsSnap.docs) {
        if (doneIds.has(habitDoc.id)) continue;
        const h     = habitDoc.data();
        const title = `${h.icon || '⭐'} ${h.name}`;
        const body  = h.twoMinuteVersion
          ? `2 Min: ${h.twoMinuteVersion}`
          : (h.cue ? `Auslöser: ${h.cue}` : 'Zeit für deine Gewohnheit!');

        for (const token of tokens) {
          const msg = {
            token,
            notification: { title, body },
            data: { habitId: habitDoc.id, url: APP_URL },
            webpush: {
              notification: {
                icon:  `${APP_URL}/icon-192.png`,
                badge: `${APP_URL}/icon-192.png`,
                requireInteraction: false,
                vibrate: [200, 100, 200],
              },
              fcmOptions: { link: APP_URL }
            },
            apns: {
              payload: { aps: { sound: 'default', badge: 1 } }
            }
          };

          sends.push(
            fcm.send(msg).catch(async err => {
              if (
                err.code === 'messaging/invalid-registration-token' ||
                err.code === 'messaging/registration-token-not-registered'
              ) {
                const stale = tokenDocs.find(d => d.data().token === token);
                if (stale) await stale.ref.delete();
              }
            })
          );
        }
      }
    }

    await Promise.all(sends);
    return null;
  });
