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
    const now      = new Date();
    const HH       = String(now.getHours()).padStart(2, '0');
    const MM       = String(now.getMinutes()).padStart(2, '0');
    const timeStr  = `${HH}:${MM}`;
    const todayStr = now.toISOString().split('T')[0];
    const url      = APP_URL;

    const usersSnap = await db.collection('users').get();
    const sends = [];

    for (const userDoc of usersSnap.docs) {
      const userRef = db.collection('users').doc(userDoc.id);

      const habitsSnap = await userRef.collection('habits')
        .where('notifyAt', '==', timeStr).get();
      if (habitsSnap.empty) continue;

      const compSnap = await userRef.collection('completions')
        .where('date', '==', todayStr).where('completed', '==', true).get();
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
                  icon: `${url}/icon-192.png`,
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
