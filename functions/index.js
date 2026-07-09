'use strict';

const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
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
              data: { habitId: habitDoc.id, url, title, body },
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

// ── FlowSavvy API Proxy ────────────────────────────────────────────────
// Dünner Proxy: löst das fehlende CORS der FlowSavvy-API. Der API-Key kommt
// pro Request aus dem Client (localStorage). Login (request.auth) ist Pflicht,
// damit der Proxy kein offenes Relay ist.
const FLOWSAVVY_BASE = 'https://my.flowsavvy.app';

exports.flowsavvy = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login erforderlich.');
  }

  const { method = 'GET', path, body, apiKey } = request.data || {};

  if (!apiKey || typeof apiKey !== 'string') {
    throw new HttpsError('invalid-argument', 'apiKey fehlt.');
  }
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new HttpsError('invalid-argument', 'Ungültiger Pfad.');
  }
  const m = String(method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(m)) {
    throw new HttpsError('invalid-argument', 'Ungültige Methode.');
  }

  let r;
  try {
    r = await fetch(FLOWSAVVY_BASE + path, {
      method: m,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: (m === 'GET' || m === 'DELETE' || body == null) ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    throw new HttpsError('unavailable', 'FlowSavvy nicht erreichbar: ' + e.message);
  }

  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }

  return { status: r.status, ok: r.ok, data };
});
