# Organiser accounts, PIN sign-in and sessions

This document describes the multi-organiser access system added to the QQSGP
Free Fire registration project. It replaces the old model in which everybody
shares one long "dashboard key" pasted into the browser.

The dashboard itself is unchanged in what it does: it reads the `Registrations`
sheet, changes team status, writes notes, exports CSV and drives the WhatsApp
notifications module. What changed is who is allowed to do it, and how that is
proved.

---

## 1. What lives where

| Thing | Where it lives | Notes |
|---|---|---|
| Organiser accounts (id, name, role, PBKDF2 verifier) | Apps Script **Script Properties**, key `org_accounts_v1` | Split across numbered chunks because a property value is capped near 9 KB |
| Sessions | Apps Script **Script Properties**, key `org_sessions_v1` | Only the SHA-256 hash of a token is stored |
| Audit trail | A new **`Audit`** tab in the spreadsheet | Login, logout, refused logins, account changes, refused permissions |
| Login lockout counters | **CacheService** (short-lived) | Not persisted by design; a lockout is a 15-minute throttle |
| The spreadsheet ID | Script Property `sheet_id` | See §6 — this is what lets the deployed web app find the sheet |
| Team registrations and payment/approval status | The `Registrations` sheet | The original 12 columns are untouched. Payment and approval columns were **appended on the right** (entry fee, method, status, UPI reference, note, updated at/by, approval status, rejection reason). Older rows keep working; a missing payment cell reads as "not selected". |

No PIN, no verifier, no session token and no shared key is stored in the
repository, in `admin.html`, in `admin.js`, or in any page served to a visitor.

---

## 2. Sign in versus the recovery key

There are two ways in, and they are not equal.

**Organiser ID + PIN (normal path).** Every organiser has their own id and
personal PIN. The PIN is verified on the server. A successful sign-in mints a
session token that the browser keeps, and every later request carries it.

**The dashboard key (recovery only).** The old shared key still works, because
removing it without a working PIN would lock everybody out of their own
tournament. It is treated as a Super Admin credential. It is *not* used
automatically any more: if a browser still has it saved, the dashboard opens
the "Use the recovery key instead" section and pre-fills it, but you have to
click.

**Retire it once every organiser has an account.** In the Apps Script editor:
**Project Settings → Script Properties → delete `admin_key` → Save.** After
that the only way in is an organiser ID and PIN.

---

## 3. Creating the first Super Admin

The deployed project is a **standalone** script (not bound to the spreadsheet),
so the spreadsheet's `Tournament` menu is not available on this deployment. Use
the editor:

1. Open the Apps Script project → **Editor**.
2. Choose `setupSuperAdmin` from the function dropdown next to **Run**.
3. **Run**. Authorise it if prompted.
4. The **Execution log** prints four lines. Copy the last three:

   ```
   Organiser ID: admin
   PIN: XXXX-XXXX-XXXX-XXXX
   ```

That PIN is generated at random, shown once, and **not stored** — only its
salted verifier is. If you lose it, run `setupSuperAdmin()` again after deleting
the account, or reset it from the dashboard (§5).

There is no default PIN anywhere in this project, and no administrator password
in the code.

To create more accounts from the editor:

```js
createOrganiserAccount('ravi.k', 'Some-Strong-Pin-9', 'ORGANIZER', 'Ravi Kumar');
createOrganiserAccount('deputy', 'Another-Strong-Pin-4', 'SUPER', 'Deputy Chief');
organiserStatus();        // lists accounts, never prints a secret
revokeOrganiserSessions('ravi.k');
```

Or make them from the dashboard while signed in as a Super Admin (§5).

---

## 4. Roles

Permissions are checked **on the server** for every action. Hiding a button is
never what stops somebody: an Organizer that sends a Super Admin request by hand
gets `{ ok: false, code: "FORBIDDEN" }`.

| Permission | Super Admin | Organizer |
|---|---|---|
| `records.view` — list, search, filter registrations | yes | yes |
| `records.update` — approve / reject / waitlist, notes | yes | yes |
| `records.export` — CSV export | yes | yes |
| `wa.view` — notification log, announcement preview | yes | yes |
| `wa.send` — send an announcement, retry a failed message | yes | yes |
| `accounts.manage` — create / disable / re-role / reset / delete accounts | yes | **no** |
| `sessions.manage` — see and end signed-in devices | yes | **no** |
| `audit.view` — read the audit trail | yes | **no** |

An Organizer can never promote themselves or anyone else: the role change goes
through `accounts.manage`, which their role does not hold. Two further rules are
enforced in the backend regardless of role:

- The **last enabled Super Admin** cannot be demoted, disabled or deleted. That
  would leave nobody able to manage accounts.
- A role change, a PIN reset or a disable **immediately ends that account's
  sessions**, everywhere, so the change takes effect at once.

---

## 5. Running it day to day

**From the phone or any laptop:** open the dashboard URL, type your organiser ID
and PIN. Everything is served from the same Apps Script backend and the same
sheet, so every device sees the same registrations. Nothing depends on a laptop
being on.

**"Keep me signed in on this device"** stores the session token in
`localStorage` so it survives a reload and lasts up to 30 days. Without it the
token lives in `sessionStorage` for that tab and expires after 12 idle hours.

**Super Admin panel** (bottom of the dashboard, only for `accounts.manage`):

- list every account with role, enabled/disabled, last sign-in and device
- **Add an organiser** — id, name, role, PIN
- **Reset PIN** — asks for the new PIN, ends that account's sessions
- **Disable / Enable**
- **Make Super Admin / Make Organizer**
- **Sign out** — ends every session that account holds
- **Signed-in devices** — one row per live session, with *End session*
- **Audit trail** — the last 25 events

**Change your own PIN** — any signed-in organiser, using the *Change your own
PIN* form. It requires the current PIN and signs your other devices out.

**Signing out** ends the session on the server and clears the browser. Even if
the network call fails, the browser is cleared.

---

## 6. Why the spreadsheet ID is in Script Properties

A web app deployed as *Execute as me* / *Anyone* has **no active spreadsheet**,
so `SpreadsheetApp.getActiveSpreadsheet()` returns `null` inside a request. This
deployment is standalone, so the script must know its spreadsheet by ID.

Putting that ID in `apps-script.js` would publish it in a public repository.
Instead `CONFIG.SHEET_ID` is left empty and the script reads the `sheet_id`
Script Property:

**Project Settings → Script Properties → Add script property**

| Property | Value |
|---|---|
| `sheet_id` | the ID in your spreadsheet URL: `docs.google.com/spreadsheets/d/**THIS_PART**/edit` |

This also means a fresh copy of `apps-script.js` can be pushed and deployed
without editing anything, and a deploy can no longer break the live counters by
overwriting a pinned ID.

---

## 7. PIN policy and the honest limits

The policy, enforced at creation and at reset:

- 6 to 64 characters. Letters, digits and symbols are all allowed.
- Refused: one character repeated (`555555`), a straight run of four or more
  (`1234`, `654321`), a list of common PINs and passwords, anything containing
  the organiser's own ID, and anything equal to it.

**A six-digit PIN is not a strong secret.** It is a one-in-a-million guess, and
a real attacker can try many guesses per second offline. This system compensates
with the pieces that actually matter here:

- **The verifier never leaves the server.** It sits in Script Properties, which
  only this script can read. It is not in the sheet, the repository or any
  response.
- **The verifier is salted and slow.** PBKDF2-HMAC-SHA256, 32 hex characters of
  salt per account, with an iteration count **calibrated at creation time to
  about 400 ms** on this runtime and recorded inside the verifier so
  verification repeats exactly the same work. Measured on the live deployment,
  creating the first account took about 8 seconds end to end including
  authorisation and the first write.
- **Five wrong attempts lock the submitted ID out for 15 minutes.** The counter
  is keyed on the submitted ID, so guessing ids is exactly as slow as guessing
  PINs.
- **A wrong PIN and an unknown ID answer with the same message, and an unknown
  ID is put through the same PBKDF2 work**, so response timing does not reveal
  which organiser IDs exist.

### Honest limitations

1. **PBKDF2 cost is far below the OWASP recommendation.** OWASP suggests 600 000
   iterations for PBKDF2-HMAC-SHA256. Apps Script has no bcrypt/Argon2 and every
   iteration is a native call, so 600 000 iterations would take minutes per
   login. The calibrated count here is in the hundreds, capped at 20 000. The
   mitigation is that verifiers are server-side and unreadable, and lockout
   throttles online guessing — not the hash cost. Use a longer alphanumeric PIN
   or passphrase for any account that matters.
2. **There are no cookies.** Apps Script serves the dashboard from
   `script.google.com/macros/.../exec` and redirects every response to
   `script.googleusercontent.com`, so it cannot set a secure `HttpOnly` cookie on
   a page served by GitHub Pages. Sessions are therefore a bearer token held in
   browser storage rather than a cookie. Practical consequences: it is only as
   safe as the device's storage; there is no `HttpOnly` protection against
   XSS; and `SameSite` does not apply.
3. **CSRF is mitigated structurally, not by a token.** The credential travels in
   the request body, not in an ambient cookie, so a page on another origin
   cannot ride along on a signed-in session. Requests use
   `Content-Type: text/plain`, which Apps Script answers without a CORS
   preflight.
4. **Lockout counters live in CacheService** and can be evicted early. That
   weakens a sustained guessing attack; it cannot be used to bypass a correct
   PIN, which is still verified cryptographically.
5. **Concurrent requests to a fresh deployment can return a Google error page.**
   Apps Script redirects each POST to a single-use
   `script.googleusercontent.com` URL. Firing several calls at once occasionally
   produced a 404 "Page not found" body instead of JSON. Fire login and the
   panel loads sequentially, as the dashboard itself does.
6. **Account management is not a Google-identity login.** There is no Google
   Sign-In and no per-organiser Drive identity; the audit trail records the
   organiser id and the device string, not a verified email address.

---

## 8. Publishing a changed backend

1. Edit `apps-script.js`.
2. Deploy a **new version** on the **same deployment ID** so the URL in
   `script.js` and `admin.js` never changes:

   ```bash
   cd .clasp-push          # git-ignored staging copy
   cp ../apps-script.js Code.js
   clasp push -f
   clasp create-version "what changed"
   clasp deploy -V <n> -i <the existing deployment ID> -d "what changed"
   ```

3. Reload the sheet, then `?action=stats` should answer with real numbers. If it
   answers `No spreadsheet found`, the `sheet_id` Script Property is missing
   (§6).

`.clasp-push/` is git-ignored so no staging copy, script id or credential of
yours can be committed.

---

## 9. Verifying the system yourself

```bash
node verify-apps-script.js
```

419 assertions run against a mocked Apps Script runtime (this number includes
the 318 that existed before this change, all still passing). The auth sections
are **21–28**:

| Section | Covers |
|---|---|
| 21 | account creation, salting, PBKDF2 verifier shape, weak-PIN and bad-ID rejection |
| 22 | valid/invalid sign-in, unknown id answering identically, no PIN echoed |
| 23 | lockout after repeated failures, lockout not revealing whether an id exists |
| 24 | forged/malformed tokens, session seeing shared data, an Organizer refused every Super Admin action, still allowed its own |
| 25 | logout, session expiry, session list without tokens, ending a single device |
| 26 | disable, enable, PIN reset, last-Super-Admin protection, self-service PIN change |
| 27 | audit contents, no PIN or token in the audit, public routes still open |
| 28 | the deployed web app finding its spreadsheet via Script Properties |

The PBKDF2 implementation itself is checked against the published
PBKDF2-HMAC-SHA256 test vectors (5/5 match), not only against itself.

### Verified on the live deployment

Performed against `AKfycbw_-E7L9...` (version 4) and the real spreadsheet:

- valid organiser ID + PIN → session token, role `SUPER`, 8 permissions
- wrong PIN → refused; unknown ID → refused with the same wording
- five wrong attempts → `LOCKED` for 15 minutes; the real account unaffected
- an Organizer signed in with 5 permissions; `account-list`, `audit-list`,
  `session-list`, `account-revoke-sessions` and self-promotion all returned
  `FORBIDDEN`, while listing registrations returned the same 11 rows
- that Organizer was then deleted; its session was revoked and its PIN stopped
  working
- two independent sessions in two browser tabs both saw the same 11
  registrations
- a second account was created through the dashboard and signed in successfully
- audit trail recorded: logins, a logout, refused logins, account creation
- public `?action=stats` returned real data, invalid and markup payloads were
  rejected, and the team/player counts were unchanged afterwards (no rogue row)
- the dashboard loaded with no console errors