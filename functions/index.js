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

// ── Garmin Connect Proxy ───────────────────────────────────────────────
// Holt Schlaf-/Gesundheitsdaten fürs Morgen-Briefing. Die Zugangsdaten
// kommen pro Request aus dem Client (localStorage); der OAuth-Token wird
// pro Nutzer in Firestore gecacht, damit nicht jeder Aufruf neu einloggt.
// Hinweis: garmin-connect ist eine inoffizielle Bibliothek — Konten mit
// aktivierter MFA/2FA funktionieren i.d.R. nicht.
const { GarminConnect } = require('garmin-connect');

const ymd = d => d.toISOString().split('T')[0];
const fmtDur = sec => {
  if (sec == null || isNaN(sec)) return null;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
};

exports.garmin = onCall({ region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login erforderlich.');
  }
  const { email, pass } = request.data || {};
  if (!email || !pass) {
    throw new HttpsError('invalid-argument', 'Garmin-Zugangsdaten fehlen.');
  }

  const uid = request.auth.uid;
  const tokenRef = db.collection('users').doc(uid).collection('private').doc('garmin');
  const client = new GarminConnect({ username: email, password: pass });

  // 1) Gecachten Token laden, sonst frisch einloggen.
  let authed = false;
  try {
    const snap = await tokenRef.get();
    const tok = snap.exists ? snap.data().token : null;
    if (tok && tok.oauth1 && tok.oauth2 && typeof client.loadToken === 'function') {
      client.loadToken(tok.oauth1, tok.oauth2);
      authed = true;
    }
  } catch (_) {}

  async function login() {
    await client.login();
    authed = true;
    try {
      if (typeof client.exportToken === 'function') {
        await tokenRef.set({ token: client.exportToken(), at: Date.now() }, { merge: true });
      }
    } catch (_) {}
  }

  if (!authed) {
    try { await login(); }
    catch (e) { return { ok: false, error: 'login-failed', message: e.message }; }
  }

  // Ruft fn() auf; bei Fehler (evtl. abgelaufener Token) einmal neu einloggen.
  async function tryFetch(fn) {
    try { return await fn(); }
    catch (e1) {
      try { await login(); return await fn(); }
      catch (e2) { return null; }
    }
  }

  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  const result = {};

  // Schlaf letzte Nacht
  const sleepRaw = await tryFetch(() =>
    typeof client.getSleepData === 'function' ? client.getSleepData(ymd(today)) : null);
  if (sleepRaw) {
    const dto = sleepRaw.dailySleepDTO || sleepRaw;
    result.sleep = {
      durationText: fmtDur(dto.sleepTimeSeconds),
      score: dto.sleepScores?.overall?.value ?? dto.overallSleepScore ?? null,
      deepText: fmtDur(dto.deepSleepSeconds),
      remText: fmtDur(dto.remSleepSeconds)
    };
  }

  // Schritte gestern
  const stepsRaw = await tryFetch(() =>
    typeof client.getSteps === 'function' ? client.getSteps(ymd(yest)) : null);
  if (typeof stepsRaw === 'number') result.steps = stepsRaw;
  else if (stepsRaw && typeof stepsRaw.totalSteps === 'number') result.steps = stepsRaw.totalSteps;

  // Ruhepuls gestern
  const hrRaw = await tryFetch(() =>
    typeof client.getHeartRate === 'function' ? client.getHeartRate(ymd(yest)) : null);
  if (hrRaw && hrRaw.restingHeartRate != null) result.restingHR = hrRaw.restingHeartRate;

  // Body Battery / Stress / HRV — best effort über die Low-Level-API.
  if (typeof client.get === 'function') {
    const bb = await tryFetch(() =>
      client.get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${ymd(yest)}&endDate=${ymd(yest)}`));
    try {
      const vals = bb?.[0]?.bodyBatteryValuesArray;
      if (Array.isArray(vals) && vals.length) result.bodyBattery = vals[vals.length - 1][1];
    } catch (_) {}

    const stress = await tryFetch(() =>
      client.get(`/wellness-service/wellness/dailyStress/${ymd(yest)}`));
    if (stress && stress.avgStressLevel != null) result.stress = stress.avgStressLevel;

    const hrv = await tryFetch(() =>
      client.get(`/hrv-service/hrv/${ymd(today)}`));
    if (hrv && hrv.hrvSummary?.lastNightAvg != null) result.hrv = hrv.hrvSummary.lastNightAvg;
  }

  return { ok: true, data: result };
});
