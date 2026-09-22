'use strict';
/*
 * Firebase: the sign-in, and everything the Invoices page reads or writes.
 *
 * This is the SAME Firebase project as the Instruction Manual and the Email
 * Service — pharmacy-shop-c9488 — and deliberately the same collections the
 * manual's /invoices route uses (`invoices`, `counters/invoices`,
 * `pharmacies`). An invoice written here shows up in the manual's history and
 * vice versa; the numbering counter is shared, so the two can't issue the same
 * number. Nothing about the data model is this app's to change on its own: if
 * a field moves, it moves in both places, and firestore.rules (which lives in
 * the manual and the Email Service, not here) has to allow it.
 *
 * Access is the manual's `manualRole` custom claim — admin, editor or viewer.
 * Note what the check is NOT: "is signed in". Public sign-up is open on this
 * Firebase project, so anyone can make themselves an account; a claimless one
 * gets the no-access screen here and is refused by the rules server-side.
 * Only an admin (through the manual's People screen) can grant the claim.
 *
 * Uses the Firebase compat bundles in /vendor — see scripts/vendor.js.
 */
var InvoiceStore = (function () {
  // These are not secrets. A Firebase web config is public by design; access
  // is enforced by Firestore security rules and Auth, not by hiding them.
  // Identical to the manual's NEXT_PUBLIC_FIREBASE_* values.
  const CONFIG = {
    apiKey: 'AIzaSyDN550VtEfT1sSBmrolPaSeHlfNWWPlFho',
    authDomain: 'pharmacy-shop-c9488.firebaseapp.com',
    projectId: 'pharmacy-shop-c9488',
    storageBucket: 'pharmacy-shop-c9488.firebasestorage.app',
    messagingSenderId: '181885154552',
    appId: '1:181885154552:web:46029d28938d1eccb7b70d',
  };

  /** The claim the manual grants, and the three values that mean "may use this". */
  const ROLE_CLAIM = 'manualRole';
  const ROLES = ['admin', 'editor', 'viewer'];

  /** Where the numbering starts, per the pharmacy's own choice. */
  const FIRST_INVOICE_NUMBER = 1389;

  /** How many invoices the history panel holds at once — see watchInvoices. */
  const HISTORY_LIMIT = 500;

  let app = null, auth = null, db = null, startError = '';

  try {
    app = firebase.initializeApp(CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    // Stay signed in across restarts — this is a shop computer that gets
    // closed at the end of a shift, not a shared browser.
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
  } catch (e) {
    startError = (e && e.message) || String(e);
  }

  const stamp = () => firebase.firestore.FieldValue.serverTimestamp();

  // ---------------------------------------------------------------------------
  // Sign-in
  // ---------------------------------------------------------------------------

  /**
   * Calls back with { user, email, uid, role, ready } whenever either the user
   * or their token changes. Returns an unsubscribe.
   *
   * onIdTokenChanged rather than onAuthStateChanged: the role lives in a custom
   * claim, so the page has to react when the TOKEN changes, not just when the
   * user does. Granting or revoking a role server-side revokes the refresh
   * token, and the new claim arrives here on the next refresh — so someone
   * promoted in the manual gets in here without restarting the app.
   */
  function watchAuth(onChange) {
    if (!auth) { onChange({ user: null, role: null, ready: true, error: startError }); return () => {}; }
    return auth.onIdTokenChanged(async (user) => {
      if (!user) { onChange({ user: null, email: '', uid: '', role: null, ready: true }); return; }
      let role = null;
      try {
        const claims = (await user.getIdTokenResult()).claims || {};
        const r = claims[ROLE_CLAIM];
        role = ROLES.includes(r) ? r : null;
      } catch { role = null; }
      onChange({ user, email: user.email || '', uid: user.uid, role, ready: true });
    });
  }

  const signIn = (email, password) =>
    auth.signInWithEmailAndPassword(String(email).trim().toLowerCase(), password);
  const signOut = () => auth.signOut();
  const sendReset = (email) =>
    auth.sendPasswordResetEmail(String(email).trim().toLowerCase());

  /** Firebase's auth error codes, turned into something a technician can act on. */
  function readableAuthError(err) {
    const code = String((err && (err.code || err.message)) || '');
    if (/invalid-credential|wrong-password|user-not-found/.test(code)) {
      return "That email and password don't match an account.";
    }
    if (code.includes('invalid-email')) return "That doesn't look like an email address.";
    if (code.includes('user-disabled')) return 'This account has been turned off. Ask Carson.';
    if (code.includes('too-many-requests')) return 'Too many tries. Wait a minute, then try again.';
    if (code.includes('missing-password')) return 'Type your password.';
    if (code.includes('network')) return 'No connection. Check the shop wifi and try again.';
    return (err && err.message) || 'Could not sign in. Tell Carson what the screen says.';
  }

  // ---------------------------------------------------------------------------
  // The pharmacy directory
  // ---------------------------------------------------------------------------
  //
  // Small, shared, and mutable — a pharmacy that moves premises should be
  // corrected in one place rather than retyped. That is safe because a saved
  // invoice keeps its own full copy of the address it was printed with, so
  // editing a client here never rewrites history.

  const CLIENT_FIELDS = ['name', 'street', 'cityStateZip', 'phone', 'fax', 'dea'];

  /** Live directory, sorted by name. Returns an unsubscribe. */
  function watchClients(onChange, onError) {
    return db.collection('pharmacies').orderBy('nameLower').onSnapshot(
      (snap) => onChange(snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
      (e) => onError && onError(e.message),
    );
  }

  function asRecord(party) {
    const out = {};
    for (const f of CLIENT_FIELDS) out[f] = String(party[f] || '').trim();
    // Lowercased purely so Firestore can sort case-insensitively.
    out.nameLower = out.name.toLowerCase();
    return out;
  }

  async function createClient(party, uid) {
    const created = await db.collection('pharmacies').add(
      Object.assign(asRecord(party), { createdAt: stamp(), updatedAt: stamp(), createdBy: uid }));
    return created.id;
  }

  const updateClient = (id, party) =>
    db.collection('pharmacies').doc(id).update(Object.assign(asRecord(party), { updatedAt: stamp() }));

  const deleteClient = (id) => db.collection('pharmacies').doc(id).delete();

  /** Whether the block on the sheet still matches the client it came from. */
  const matchesClient = (party, client) =>
    CLIENT_FIELDS.every((f) => String(party[f] || '').trim() === String(client[f] || '').trim());

  /** Name, address or DEA — whatever the pharmacist happens to remember. */
  function searchClients(clients, term) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [c.name, c.street, c.cityStateZip, c.dea].join(' ').toLowerCase().includes(q));
  }

  // ---------------------------------------------------------------------------
  // Saved invoices, and the counter that numbers them
  // ---------------------------------------------------------------------------
  //
  // An invoice is a record of a controlled-substance transfer, so it is
  // written once and never edited — firestore.rules enforces that, not just
  // this file. A mistake is corrected the way it would be on paper: void the
  // slip and write a new one. That keeps the numbering continuous, which is
  // the point of numbering it at all.

  const counterRef = () => db.collection('counters').doc('invoices');

  /**
   * Claim the next invoice number. A transaction rather than an increment
   * because two computers can hit Print at the same moment — this app and the
   * manual's /invoices route share the counter — and two slips carrying the
   * same number would be worse than a gap.
   */
  function claimInvoiceNumber() {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef());
      const next = snap.exists ? snap.data().next : FIRST_INVOICE_NUMBER;
      tx.set(counterRef(), { next: next + 1 }, { merge: true });
      return next;
    });
  }

  /** The number the next invoice will get, watched live for the preview. */
  function watchNextNumber(onChange) {
    return counterRef().onSnapshot(
      (snap) => onChange(snap.exists ? snap.data().next : FIRST_INVOICE_NUMBER),
      () => onChange(null),
    );
  }

  async function saveInvoice(invoice, uid, email) {
    const record = {
      number: Number(invoice.invoiceNumber) || 0,
      date: invoice.date,
      toName: String(invoice.to.name || '').trim(),
      total: Invoicing.totals(invoice).total,
      sheetCount: Invoicing.sheetsFor(invoice).length,
      invoice,
      createdAt: stamp(),
      createdBy: uid,
      createdByEmail: email,
      voided: false,
    };
    /* Keyed by invoice number, so the same number can never be written twice —
       the rules reject an overwrite, which turns a double-click into an error
       rather than a silently replaced record. */
    await db.collection('invoices').doc(String(invoice.invoiceNumber)).set(record);
    return String(invoice.invoiceNumber);
  }

  /**
   * The most recent invoices, newest first. Everything is filtered in the app
   * rather than queried: Firestore can't search inside a drug name or a lot
   * number, and at a few hundred slips a year the whole history is small. Past
   * HISTORY_LIMIT the oldest fall off the list — they're still in Firestore,
   * but this panel stops showing them.
   */
  function watchInvoices(onChange, onError) {
    return db.collection('invoices').orderBy('number', 'desc').limit(HISTORY_LIMIT).onSnapshot(
      (snap) => onChange(snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
      (e) => onError && onError(e.message),
    );
  }

  /** Voiding is the only change a written invoice will accept. */
  const voidInvoice = (id, reason) =>
    db.collection('invoices').doc(id).update({
      voided: true, voidReason: String(reason || '').trim(), voidedAt: stamp(),
    });

  /** Invoice number, date, pharmacy, who wrote it, and any drug on it. */
  function searchInvoices(invoices, term) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((record) => {
      const inv = record.invoice || {};
      const lines = (inv.items || [])
        .map((i) => `${i.description} ${i.ndc} ${i.lot} ${i.schedule}`).join(' ');
      return [String(record.number), record.date, record.toName, record.createdByEmail,
        inv.pickedUpBy, lines].join(' ').toLowerCase().includes(q);
    });
  }

  return {
    startError: () => startError,
    FIRST_INVOICE_NUMBER,
    watchAuth, signIn, signOut, sendReset, readableAuthError,
    watchClients, createClient, updateClient, deleteClient, matchesClient, searchClients,
    claimInvoiceNumber, watchNextNumber, saveInvoice, watchInvoices, voidInvoice, searchInvoices,
  };
})();
