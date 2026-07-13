'use strict';
// Garmin-Token einmalig LOKAL erzeugen (deine normale IP wird nicht rate-limited,
// im Gegensatz zur Cloud-Function-IP). Danach nutzt die App nur noch diesen Token.
//
// Ausführen aus dem functions-Ordner:
//   cd functions
//   node scripts/garmin-token.js "deine@email.de" "deinPasswort"
//
// Den ausgegebenen Token-String kopieren und in HabitFlow unter
// Einstellungen (⚙️) → Garmin-Token einfügen, dann "Verbinden / Testen".
// Der Token (oauth1) hält ~1 Jahr; danach diesen Schritt wiederholen.

const { GarminConnect } = require('garmin-connect');

(async () => {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error('Nutzung: node scripts/garmin-token.js "EMAIL" "PASSWORT"');
    process.exit(1);
  }
  try {
    const client = new GarminConnect({ username: email, password });
    await client.login();
    const token = client.exportToken();
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64');
    console.log('\n=== Garmin-Token (in App-Einstellungen einfügen) ===\n');
    console.log(encoded);
    console.log('\n====================================================\n');
    process.exit(0);
  } catch (e) {
    console.error('\nLogin fehlgeschlagen:', e.message);
    console.error('Bei MFA/2FA am Konto funktioniert dieser Weg leider nicht.\n');
    process.exit(1);
  }
})();
