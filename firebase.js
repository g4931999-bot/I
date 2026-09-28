// lib/firebase.js — shared Firestore connection (unchanged logic from
// the old Vercel version, just moved into its own file).

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is missing');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

module.exports = { admin, getDb };
