'use strict';

const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore }  = require('firebase-admin/firestore');
const { getMessaging }  = require('firebase-admin/messaging');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

const APP_URL = process.env.APP_URL || 'https://habitflow-2b0dd.web.app';

// Läuft jede Minute, sendet FCM-Pushes für fällige Habits.
exports.sendHabitReminders = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1' },
  async () => {
    const now = new Date();
    const url = APP_URL;

    const usersSnap = await db.collection('users').get();
    const sends = [];

    for (const userDoc of usersSnap.docs) {
      const userRef = db.collection('users').doc(userDoc.id);

      // Ortszeit des Users — Timezone aus Firestore, Fallback UTC
      const tz = userDoc.data().timezone || 'UTC';
      const localTimeStr = now.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).slice(0, 5); // "HH:MM"
      // "Heute" in der Ortszeit des Users
      const localTodayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // "YYYY-MM-DD"

      // Habits, die genau jetzt (Ortszeit) Erinnerung haben
      const habitsSnap = await userRef.collection('habits')
        .where('notifyAt', '==', localTimeStr).get();
      if (habitsSnap.empty) continue;

      // Bereits erledigte Habits heute (in Ortszeit)
      const compSnap = await userRef.collection('completions')
        .where('date', '==', localTodayStr).where('completed', '==', true).get();
      const doneIds = new Set(compSnap.docs.map(d => d.data().habitId));

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
          sends.push(
            fcm.send({
              token,
              notification: { title, body },
              data: { habitId: habitDoc.id, url },
              webpush: {
                notification: {
                  icon:  `${url}/icon-192.png`,
                  badge: `${url}/icon-192.png`,
                  requireInteraction: false,
                  vibrate: [200, 100, 200]
                },
                fcmOptions: { link: url }
              },
              apns: {
                payload: { aps: { sound: 'default', badge: 1 } }
              }
            }).catch(async err => {
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
  }
);
