# Organiser dashboard — deployment, authentication and security

This document covers the private dashboard (`admin.html`), the extra Apps Script
endpoints it uses, and everything an organiser has to do before it will work.
The public registration page is unchanged and needs nothing from this file.

---

## 1. What lives where

| File | Where it goes | Public? |
| --- | --- | --- |
| `index.html`, `style.css`, `script.js` | GitHub Pages | Yes — the registration site |
| `rules.html`, `rules.css`, `rules.js` | GitHub Pages | Yes — tournament rules |
| `admin.html`, `admin.css`, `admin.js` | GitHub Pages | The page is public; **the data is not** |
| `logo.png`, `favicon.png` | GitHub Pages | Yes |
| `apps-script.js` | **Apps Script project only** | No |
| `verify-apps-script.js` | Local / repo only | Not deployed |

Only `apps-script.js` belongs in the Apps Script editor. Everything else is the
website. There are no other server files, and no secret belongs in any of the
GitHub Pages files.

`admin.html` being reachable does not leak anything: every request it makes is
checked on the server and refused without the dashboard key. It also carries
`<meta name="robots" content="noindex, nofollow">`.

---

## 2. Deploy the backend

1. Open the tournament Google Sheet → **Extensions → Apps Script**.
2. Replace the whole project with the current `apps-script.js` and save.
3. **Deploy → Manage deployments → pencil icon on the existing deployment.**
4. **Version: New version → Deploy.** Using *New version* on the **same**
   deployment keeps the `/exec` URL, so `script.js` and `admin.js` keep working.

   You only need **Deploy → New deployment** if there is no deployment yet.
   Then paste the new `/exec` URL into **both** `script.js` and `admin.js`
   (`APPS_SCRIPT_URL` must be identical in the two files).
5. Deployment settings (required):
   - **Execute as:** `Me` — the sheet is read and written as the owner.
   - **Who has access:** `Anyone` — anonymous visitors must be able to submit
     the registration form. This is also why the dashboard cannot use Google
     identity (see §4).

Nothing about the sheet layout is destructive. The script only:

- widens the sheet if it has fewer than 11 columns,
- writes the canonical header row in row 1,
- appends **Status** (J), **Note** (K), **WhatsApp Consent** (L) and
  **Consent At** (M).

Columns A–I are exactly what the previous version wrote. Existing rows are left
alone, and a row with a blank Status reads as `PENDING` while a blank consent
column reads as "no consent", so older registrations appear correctly in the
dashboard without a migration.

A second tab, **Notifications**, is created automatically the first time a
WhatsApp message is queued. It is a log, never a source of registrations.

Do **not** reset, clear or re-create the sheet. Do not delete rows.

---

## 3. Create the dashboard key

The key is the dashboard credential. It is generated on the server and stored in
**Script Properties** — never in `apps-script.js`, never in the repository, never
in the page.

1. Apps Script editor → choose the function **`setupAdminKey`** → **Run**.
2. Grant the permissions prompt if it appears.
3. Open **View → Execution log** (or **Ctrl+Enter** log pane). It prints:

   ```
   Dashboard key created. Paste it into admin.html once and keep it private:
   <64 hex characters>
   ```

4. Open `admin.html`, paste that value into **Dashboard key**, tick *Keep me
   signed in while this tab stays open* only on your own machine, and press
   **Open dashboard**.

Running `setupAdminKey()` again **rotates** the key: the old key stops working
immediately, and every signed-in organiser has to paste the new one. Do that if
the key is ever shared by mistake, and clear the server-side lockout while you
are at it (the helper does this for you).

The key is held in `sessionStorage` for the tab. With the checkbox ticked it is
also written to `localStorage` on that browser; **Sign out** removes both.
It is never sent anywhere except the Apps Script endpoint.

---

## 4. Authentication model — and its honest limitation

> **Superseded.** Organiser IDs, personal PINs, roles, expiring sessions,
> lockout, account management and an audit trail now exist. See
> [ORGANISERS.md](ORGANISERS.md). The shared key described below is kept only as
> a Super Admin recovery credential and should be deleted once every organiser
> has an account.

**What protects the data:** every admin call is `POST <web-app-url>?action=admin`
with a JSON body. `adminHandle_()` verifies the key **before** reading a single
cell, using a constant-time comparison against the value in Script Properties.
The checks are:

- **Deny by default.** No key configured (or shorter than 20 characters) means
  every admin call is refused. A fresh deployment cannot be opened at all until
  `setupAdminKey()` is run.
- **Lockout.** Eight wrong keys inside the 10-minute cache window lock the
  endpoint for 10 minutes, so guessing a 64-character key is not practical.
- **Opaque record ids.** A record is addressed by a SHA-256 hash of its
  timestamp and team name, recomputed server-side. A caller cannot ask for
  "row 7": unknown ids simply do not match anything.
- **Server-side validation.** Statuses are checked against `PENDING /
  APPROVED / REJECTED / WAITLISTED`, note text has markup characters rejected
  and is capped at 500 characters, and every update runs inside
  `LockService` so two organisers cannot overwrite each other.
- **Stale-write protection.** The dashboard sends the status it saw. If the row
  changed in the meantime the server answers `STALE` and the dashboard reloads
  instead of clobbering the other organiser's decision.
- **The public path is separate.** `doPost` routes `?action=admin` away from the
  registration code; a registration payload can never choose its own status, and
  the public stats endpoint returns counters only — no names, no phone numbers,
  no notes.

**The limitation, stated plainly:** a Web App deployed as *"execute as me, access:
anyone"* runs with the owner's authority and **cannot tell who is calling** — Apps
Script only exposes the caller's identity when the deployment is set to *"execute
as the user accessing the web app"*, which cannot work for anonymous
registration submissions. So the dashboard credential is a **server-verified
shared secret**, not a Google-account identity check. It is checked on the
server, so it cannot be bypassed from the browser, but it is a credential each
organiser holds and could share.

If you need Google-account identity later, the clean way is a **second Web App
deployment** of the same script with *execute as: user accessing the web app*
and access *"Anyone with a Google account"*; then `Session.getActiveUser()
.getEmail()` is trustworthy and you can allowlist addresses there while the
public deployment stays anonymous. That is a deliberate follow-up, not something
this version pretends to have.

Practical consequences to accept:

- The key is only as private as the people holding it. Rotate it after the event.
- Anyone with the key can read every registration, including phone numbers.
- There is no per-organiser audit trail — the sheet shows the current status,
  not who changed it or when.

---

## 5. Spreadsheet permissions

- Keep the sheet **private** to the organiser account. Do not use *"Anyone with
  the link"*.
- Do not publish the sheet to the web (*File → Share → Publish to web*).
- Do not give edit access to the public to make the dashboard work. The Web App
  runs as the owner; visitors never touch the sheet directly.
- The dashboard needs no Google sign-in, so nothing about the sheet's sharing
  settings changes for it.
- Share the sheet with other organisers as Google accounts (Editor), not by
  making it public.

---

## 6. Publishing the site (GitHub Pages)

1. Commit the files to the repository on `main`.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
3. Wait for the build, then open
   `https://fazeel-0108.github.io/freefire-registration/`.
4. Check `…/rules.html` and `…/admin.html` load.

Order matters on the first upgrade: **deploy the backend first**, then the site.
The new `admin.js` expects the admin endpoints, and the public page only gains
the "Registration open" pill once the new backend answers `/exec?action=stats`.

### Rollback

- The website: `git revert <commit>` (or redeploy the previous commit) and push.
- The backend: **Manage deployments → pencil → Version: previous version →
  Deploy.** Apps Script keeps older versions, so this takes seconds.
- Rolling back is safe in both directions: columns J and K keep their data, and
  the older backend simply ignores them. **No registration record is deleted by
  a rollback.**

---

## 7. Using the dashboard

- **Overview** — teams, players (counted from the actual roster columns), and
  the four status counts. All computed from the sheet on every load.
- **Search** — team name, department, player name or record id.
- **Filters** — status chips and a department list built from the data.
- **Details drawer** — full roster with a WhatsApp link per player, status
  buttons, an internal note, and *Copy WhatsApp message*. Approving a team also
  opens WhatsApp with the approval message ready to send — see below.
- **Reject** and other destructive actions ask for confirmation first.
- **Payments to review** — holds every gateway payment this project refused to
  register on its own (weak YouPI verification, wrong amount, event full at the
  moment the money landed). *Accept* asks for a note saying how you checked the
  money, then saves the team as `ONLINE`/`PAID` with your name on the row and a
  `payment-manual-accept` audit entry. *Reject* asks for a reason and closes the
  attempt without registering anyone. The panel shows which gateway is live and
  — for YouPI — the verification level it requires.
- **Export CSV** — respects the current status/department/search filters and
  includes status, note and record id.
- **Auto-refresh** every 30 seconds while the tab is visible.
- Rejected and waitlisted teams stay in the sheet. Nothing is ever deleted.

### Approve opens WhatsApp with the message typed

**Approve** does both steps in one tap:

1. It saves `APPROVED` to the sheet and waits for the server to confirm the
   write. Nothing opens before that confirmation.
2. Only then it opens `wa.me` in a new tab for the **team leader** — player 1,
   the contact column of the sheet — with the message already filled in:
   leader name, team name in bold, department, registration id, and an honest
   payment line (a team with pending cash is told the ₹100 is still due).
3. You press **Send** in WhatsApp. The dashboard never claims the message was
   sent or delivered: opening WhatsApp only pre-fills it.

What happens in the awkward cases:

| Situation | What the dashboard does |
| --- | --- |
| Leader's number missing or invalid | Asks which player should get the message, listing only usable numbers. Nothing is guessed. |
| No usable number at all | Asks for confirmation, then saves the approval without a message. |
| Save failed (offline, stale, server error) | The team stays unapproved, the reserved tab is closed, and an error is shown. |
| Browser blocked the new tab | The approval is saved and *Open WhatsApp for …* appears under **Contact** with the same message. |
| Already approved | The button is disabled; approving again sends nothing. |

Numbers are normalised to `91` + 10 digits and must start 6–9. A number that
fails that check is refused rather than repaired, so a typo can never open a
conversation with a stranger.

### WhatsApp notifications panel

Below the registrations table. It shows whether the provider is connected, the
notification log (team, type, recipient, state, time, failure reason) with a
**Retry** button on failed rows, and an announcement composer.

Announcements are previewed first: the panel reports how many teams would
receive the message, how many were skipped for missing consent or numbers, and
asks for confirmation before sending. States are the ones the provider actually
reported — *Accepted by provider* is not *Delivered*.

Everything here needs the Script Properties listed in WHATSAPP.md. Until they
are set, status changes still work and no notification rows are written. See
WHATSAPP.md for the templates, the webhook and the consent rules.

---

## 8. Security checklist before the event

- [ ] `setupAdminKey()` has been run and the key is not written in any file,
      chat, screenshot or commit.
- [ ] The sheet is private; *Publish to web* is off; no "anyone with the link".
- [ ] `admin.html` is reachable but refuses to load data without the key.
- [ ] A wrong key shows *"That key was refused"* and never partially loads data.
- [ ] Eight wrong attempts lock the endpoint for 10 minutes.
- [ ] Signing out clears the key from the browser.
- [ ] The public page shows no phone numbers, notes or statuses of individual
      teams.
- [ ] Old registrations still appear (blank status = PENDING).
- [ ] You know the rollback path for both the site and the deployment.

---

## 9. Tests performed automatically

`node verify-apps-script.js` runs the real `apps-script.js` against a mocked
Apps Script runtime: **606 checks, all passing**. They cover the registration
contract (2–4 players, duplicate team, shared phone, department list, counters,
cache invalidation, error containment), the dashboard API (deny by default,
key setup, wrong key, lockout and its expiry, listing, counts, opaque ids,
status change persistence, stale updates, unknown statuses, malformed ids,
notes, markup rejection, note length, rejected teams leaving the public
counters while keeping their row, CSV shape, filters, search, pagination,
unknown/missing admin actions), the fee in Settings, the whole verified online
payment path for **both gateways** (Razorpay QR and YouPI hosted checkout:
forged callbacks, wrong amount, wrong order, duplicate callbacks, cancel,
expiry, weak verification held for review, organiser accept/reject), and the
review queue itself.

`node verify-approve.js` extracts the approval and WhatsApp helpers from the real
`admin.js` and runs **54 checks** without a browser: Indian number
normalisation (spacing, `+91`, leading zero, and every shape that must be
refused), URL encoding of the message, the exact approval text and its payment
line for each payment status, recipient ordering, and that the Approve button is
wired to the save-then-open flow with the tab closed on failure.

The browser flows were exercised in Chromium against a local mock that speaks the
same JSON contract: the mobile submit → popup → Done path at 375/390 px and in
landscape, the 2/3/4-player registrations, every validation message, the server
error path, the gate, list, filters, drawer, approve, reject-with-confirmation,
note save, CSV payload, sign-out, the rules page and its print button.

For this release the approve flow was driven end to end in the same mock:
approve → one status POST → `wa.me/91…` opened with the exact message — plus the
missing-leader picker, the no-number confirmation, a simulated network failure
(tab closed, team still unapproved, Approve re-enabled), an already-approved
team (no second POST) and the blocked-popup fallback link. The embedded preview
browser refuses popups, so the phrase *Open WhatsApp for …* path is what it
shows; on a real phone or desktop Chrome the tab opens by itself.

## 10. Manual tests still required (they need the live account)

These cannot be done from a test harness because they need your Google account
and your sheet:

1. Run `setupAdminKey()`, paste the key into the deployed `admin.html`, and
   confirm the dashboard loads real rows.
2. Submit one test team from a phone, then confirm it appears in the dashboard
   without a manual refresh within ~30 seconds.
3. Change a status, reload the sheet, and confirm column J changed.
4. Save a note and confirm column K changed.
5. Open the dashboard in two browsers, change the same team in both, and confirm
   the second one reports a stale update instead of overwriting.
6. Confirm the eight-wrong-key lockout on the live deployment.
7. Download the CSV and open it in Excel/Sheets.
8. Verify the registration form still submits end to end after the backend
   upgrade (the deployment must be a **new version** of the same URL).
9. Print the rules page to PDF and check the layout.
10. Rotate the key after the event.

## 11. Known limitations

- No per-organiser **Google-identity** login; organisers sign in with their own
  id and PIN, so the audit trail records an organiser id and a device string
  rather than a verified email address. See [ORGANISERS.md](ORGANISERS.md).
- The audit trail covers sign-ins, logouts, refused attempts and account
  changes. It does **not** yet record which organiser changed a team's status.
- WhatsApp is **click-to-chat**: Approve opens WhatsApp with the message
  pre-filled and the organiser presses Send. There is no automatic sending, and
  no delivery state is claimed. The Cloud API panel (WHATSAPP.md) is the only
  automated path, and it is switched off until its credentials exist.
- The CSV export returns every matching record in one response; fine for a
  campus event, not for tens of thousands of rows.
- The dashboard lists at most 100 rows per request (`pageSize`), with pagination.
- Registration open/closed on the public page is derived from `MAX_TEAMS` and
  the team count. With `MAX_TEAMS = 0` it always says "Registration open".
- Tournament dates, prizes, fees, scoring and penalties are **placeholders** on
  `rules.html`, marked `[Organizer: …]`. They must be filled in by the
  organisers; nothing invented is presented as official.

---

## 12. Payment status (fee is sheet data, ₹100 to start)

The fee lives in the **Settings** tab (`entry_fee`) and is edited in the
dashboard's *Tournament settings* panel. It is copied onto the row when a team
registers, so a later price change never rewrites what an older team owed. A
team of 2, 3 or 4 players all pay the same fee.

| Team chose | Saved as | Who moves it to `PAID` |
| --- | --- | --- |
| **Online** (gateway) | `ONLINE` / **`PAID`** — written by the backend the moment the gateway reports a confirmed payment for that session, in INR, for the exact fee snapshot | Nobody. The gateway's API answer is the proof; the row carries the order id, payment id, paid amount, currency, verification time and provider. With **YouPI**, only a payment at the required verification level (default 2 = bank SMS + Gmail) counts. |
| **Cash** | `CASH` / **`PENDING`** | You, once the notes are in your hand — in the sheet on your phone, or from the dashboard. |

The gateway is chosen by the `payment_provider` Script Property: `youpi`
(default) or `razorpay` as a fallback. The **Tournament settings** panel shows
which one is live, whether it is configured, and — for YouPI — the verification
level it requires. Until it is configured, Online is offered as unavailable and
Cash still works.

A registration that simply claims `ONLINE` is refused by the backend. There is
no "I have paid" button anywhere on the site, and a typed UTR proves nothing.
If a payment arrives for the wrong amount, or YouPI reports it below the
required level, the row is **not** created. The attempt waits in
**Payments to review** on the dashboard (and in **PaymentDrafts** in the sheet):

| Reason shown | What it means |
| --- | --- |
| *Gateway could not verify strongly enough* | YouPI saw money but only through one observer. Check your bank/UPI app before accepting. |
| *Amount or currency did not match the fee* | The team paid something other than the fee snapshot. Refund or ask them to pay the difference. |
| *Paid, but the team could not be added* | The event filled up or the name was taken between opening the checkout and paying. |

**Accept** asks for a note ("seen in UPI app, UTR …"), writes the team as
`ONLINE`/`PAID` with your name and the note on the row, and adds a
`payment-manual-accept` audit entry. Pressing it twice cannot add a second team.
**Reject** asks for a reason, closes the attempt, and registers nobody.

Online payment is only offered when the selected provider's credentials exist in
Script Properties; until then the page says so and Cash still works. Setup for
both gateways, the security model, the tests and the YouPI PG assessment are in
[PAYMENTS.md](PAYMENTS.md).

`upi-qr.png` (the original FamApp image) and `upi-pay-qr.png` (its scannable
copy) are still in the repository as the organiser's own payment record, but the
site no longer collects through them: a personal UPI QR has no API to ask
whether the money arrived.

**From the phone (Google Sheets app)** — open the `Registrations` tab, find the
row, tap the **Payment Status** cell and pick `PAID` from the dropdown. The
dashboard reads the sheet on every refresh, so the change appears there too.
**From the dashboard** — Payments tab, filter *Cash pending*, press *Mark paid*,
and confirm; it writes the same cell plus who did it and when.

Approval is separate. A paid team is not approved, and an approved team is not
paid. Rejecting a team never erases its payment row.
