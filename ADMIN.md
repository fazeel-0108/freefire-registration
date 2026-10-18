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
  buttons, an internal note, and *Copy WhatsApp message* (it copies text to your
  clipboard; **nothing is sent automatically**).
- **Reject** and other destructive actions ask for confirmation first.
- **Export CSV** — respects the current status/department/search filters and
  includes status, note and record id.
- **Auto-refresh** every 30 seconds while the tab is visible.
- Rejected and waitlisted teams stay in the sheet. Nothing is ever deleted.

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
Apps Script runtime: **261 checks, all passing**. They cover the registration
contract (2–4 players, duplicate team, shared phone, department list, counters,
cache invalidation, error containment) and the dashboard API (deny by default,
key setup, wrong key, lockout and its expiry, listing, counts, opaque ids,
status change persistence, stale updates, unknown statuses, malformed ids,
notes, markup rejection, note length, rejected teams leaving the public
counters while keeping their row, CSV shape, filters, search, pagination,
unknown/missing admin actions).

The browser flows were exercised in Chromium against a local mock that speaks the
same JSON contract: the mobile submit → popup → Done path at 375/390 px and in
landscape, the 2/3/4-player registrations, every validation message, the server
error path, the gate, list, filters, drawer, approve, reject-with-confirmation,
note save, CSV payload, sign-out, the rules page and its print button.

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

- Shared dashboard key instead of per-organiser Google-identity login (§4).
- No audit trail of who changed a status or when.
- No automatic WhatsApp or email messages; the dashboard only copies text.
- The CSV export returns every matching record in one response; fine for a
  campus event, not for tens of thousands of rows.
- The dashboard lists at most 100 rows per request (`pageSize`), with pagination.
- Registration open/closed on the public page is derived from `MAX_TEAMS` and
  the team count. With `MAX_TEAMS = 0` it always says "Registration open".
- Tournament dates, prizes, fees, scoring and penalties are **placeholders** on
  `rules.html`, marked `[Organizer: …]`. They must be filled in by the
  organisers; nothing invented is presented as official.
