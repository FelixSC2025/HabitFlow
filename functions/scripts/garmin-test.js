'use strict';
// Lokaler Volltest: loggt ein UND ruft die Gesundheitsdaten ab — zeigt, ob dein
// Konto mit der Library funktioniert und wie die Rohdaten aussehen.
//   cd functions
//   node scripts/garmin-test.js "deine@email.de" "deinPasswort"

const { GarminConnect } = require('garmin-connect');

const ymd = d => d.toISOString().split('T')[0];

(async () => {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error('Nutzung: node scripts/garmin-test.js "EMAIL" "PASSWORT"');
    process.exit(1);
  }
  const client = new GarminConnect({ username: email, password });

  try {
    await client.login();
    console.log('LOGIN: ok');
  } catch (e) {
    console.error('LOGIN FEHLGESCHLAGEN:', e.message);
    process.exit(1);
  }

  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);

  async function probe(label, fn) {
    try {
      const r = await fn();
      const preview = JSON.stringify(r);
      console.log(`\n[OK] ${label}:`);
      console.log(preview ? preview.slice(0, 600) : String(r));
    } catch (e) {
      console.log(`\n[FEHLER] ${label}: ${e.message}`);
    }
  }

  await probe('getSleepData(today)', () => client.getSleepData(ymd(today)));
  await probe('getSteps(yesterday)', () => client.getSteps(ymd(yest)));
  await probe('getHeartRate(yesterday)', () => client.getHeartRate(ymd(yest)));
  await probe('bodyBattery', () => client.get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${ymd(yest)}&endDate=${ymd(yest)}`));
  await probe('dailyStress', () => client.get(`/wellness-service/wellness/dailyStress/${ymd(yest)}`));
  await probe('hrv', () => client.get(`/hrv-service/hrv/${ymd(today)}`));

  console.log('\nFertig.');
  process.exit(0);
})();
