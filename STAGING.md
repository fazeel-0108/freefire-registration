# STAGING — QQSGP × YouPI PG

Status: **23 October 2026.** This file records what is actually running, what was
actually verified, and what still needs an account holder. It is not a promise
that online payment is live.

---

## 1. Integration method actually used

YouPI's documented **REST hosted-checkout API**, not the JavaScript SDK and not a
hand-drawn QR.

Apps Script cannot install `@youpi/merchant-sdk`, so the adapter uses the same
contract the SDK wraps:

| Step | Request | What is checked |
| --- | --- | --- |
| Open | `POST /api/v1/payments` | `X-Merchant-Id`, `X-Merchant-Key`, `Idempotency-Key`; body `orderId`, `amount`, `currency`, `description`, `metadata` |
| Show | `checkoutUrl` from the answer | Must be an `http(s)` URL; the page embeds YouPI's own hosted checkout |
| Verify | `GET /api/v1/payments/{paymentId}` | Same merchant credentials; `SUCCESS`, exact `orderId`, exact `amountPaise`, `INR`, and `verificationLevel` at or above the configured minimum |
| Cancel | `POST /api/v1/checkout/{paymentId}/cancel` | Best effort when the team backs out |

Important consequences of the real contract:

- The order id is generated **server-side** from our draft token, never taken
  from the browser.
- The merchant key is the merchant's **webhook secret**, sent only from Apps
  Script. It never reaches the page, the Sheet, an audit line or a URL.
- `verificationLevel` is returned only to the owning merchant. A redacted public
  answer has no level at all; the adapter treats that as `IDENTITY MISMATCH`,
  not as level 0. Regression tests cover missing, null, empty and redacted
  replies.
- The webhook at `?action=paywebhook` is a **doorbell only**. Apps Script cannot
  read request headers, so no HMAC is checked there; it looks up the draft and
  asks the gateway directly. A forged `SUCCESS` body registers nobody.
- The browser has no "I have paid" button. A client-supplied `ONLINE`/`PAID`
  value is refused by `validatePaymentChoice_`.

Code: `youpiCall_`, `youpiCreatePayment_`, `verifyYoupiPayment_` and
`publicPaymentStatus_` in [apps-script.js](apps-script.js). Behaviour and
guardrails: [PAYMENTS.md](PAYMENTS.md).

---

## 2. What is running, and where

### No local mock backend

The mock harness that used to live here (`node .preview-server.js . 8788`, its
`/__test/...` pages, the `/__mock/*` endpoints and `verify-preview-isolation.js`)
was **removed on request**. Nothing in this repository can now serve fake
registrations, fake rooms or a stand-in checkout. Every test runs against the
real published site and the real `/exec` deployment.

### Local YouPI PG V2 (separate clone, not part of this repository)

| Item | Value |
| --- | --- |
| Path | `F:\F_Temp\youpi\repo` |
| Commit | `90eecd5` (20 Oct 2026) |
| Node | 24.14.0 (YouPI requires ≥ 22.13, recommends 24 LTS) |
| Database | local SQLite, `data/youpi_pg.sqlite` |
| Merchant | default demo merchant `00000000-0000-0000-0000-000000000001` |
| Receiving account | dummy `merchant@upi` only |
| Observers | none (no bank SMS device, no Gmail OAuth, no real VPA) |
| Services | started for the 23 Oct checks: payment API `:6100`, checkout portal `:7000`; **not running now** (the environment restarted). Restart with the commands in §7. |
| Health | last check: `GET /health` → `200 {"status":"UP"}` |

No public tunnel was created. No real receiving account, OTP, bank credential or
FamApp credential is configured anywhere in this workspace.

---

## 3. Live contract check — 23 Oct 2026

Run against the local YouPI instance with its own demo merchant key, read
programmatically and never printed:

| Call | Result |
| --- | --- |
| `POST /api/v1/payments` with merchant headers + `Idempotency-Key`, `₹100.00` | `201`; echo of `orderId`; `amount 100.00`; `amountPaise 10000`; `INR`; checkout URL returned |
| `GET /api/v1/payments/{id}` with `X-Merchant-Key` | `200`; owner view; `verificationLevel 0`, verification tag present |
| Same GET without a key | `200`; **no** `verificationLevel` field (redacted view) |
| `POST /api/v1/payments` with a wrong key | `401 INVALID_MERCHANT_KEY` |
| `POST /api/v1/checkout/{id}/cancel` | `200 CANCELLED`; next owner GET reads `CANCELLED` |
| Checkout page `http://localhost:7000/checkout/{id}` | Loads YouPI's real checkout UI |
| Advancing checkout | Blocked at **WhatsApp OTP sign-in**, which requires the payer's phone; not attempted |
| `youpiCreatePayment_` itself, against the running instance | `ok:true`; payment id; `http(s)` checkout URL; `₹100.00` / `INR` |
| `verifyYoupiPayment_` on that fresh session | `{ state: "PENDING", paymentStatus: "INITIATED" }` |
| `youpiCall_` cancel + `verifyYoupiPayment_` again | cancel `CANCELLED`; verification reads `{ state: "CANCELLED" }` |
| **Synthetic** two-channel test (local demo merchant): SMS + Gmail injections of `₹100.00` against an ACTIVE session, with Test Mode enabled for under a minute | Both injections `VERIFIED`; the real `verifyYoupiPayment_` returned `PAID`, `verificationLevel 2`, tag `Dual Verification (SMS_GATEWAY + Gmail)` |
| Real money moved | **None** |

The synthetic two-channel run is a **test-mode simulation** of bank observations,
not a provider or bank settlement. Test Mode was switched off immediately
afterwards (the admin endpoint then reported `enabled:false`), the local
receiving-account slot was released, and the session stayed only in the local
YouPI database. The site did not fabricate anything: the only `SUCCESS` came
from YouPI's own test-mode simulator, and no team was registered from it. The
ordinary checkout session created earlier was cancelled.

A **read-only** call to the live production deployment at the same time
(`…/exec?action=config`, no credentials, no writes) answered
`{"ok":true,"fee":100,"online":false,"provider":"YOUPI","hosted":true,"minVerification":2}`,
so production is running the consolidated YouPI code with online payment off.
Its public `?action=stats` counter reported 2 teams / 4 players, last entry
23 Oct 21:46. This check only read public aggregates; it did not read rows and
wrote nothing. If that entry is not yours, treat it as an unexplained
registration and inspect the production Sheet by hand.

What this proves: the adapter's create, owner-authenticated status read,
level-2 acceptance, amount/order/currency checks, cancel and pending states all
work against the real YouPI API. What it does **not** prove: that a real UPI
transfer reached any account, that FamApp permits this use, or that a real bank
SMS/Gmail observer is configured.

---

## 3b. Why the live page has no working online option

Production `…/exec?action=config` answers `online:false`, so the option is not
being hidden by a frontend bug: the server decides. `online` is true only when
`youpi_base_url` (an `http(s)` URL), `youpi_merchant_id` and
`youpi_merchant_key` all exist as Script Properties. At least one is absent on
production, so `POST ?action=payorder` answers `PAYMENT_OFFLINE` before reading
the body and writes no draft and no row.

Two small local changes make that diagnosable and stop the page implying a
glitch:

- `settings-get` now returns the **names** of the missing properties (never
  their values) and the dashboard prints them next to the fee, so the organiser
  can see `youpi_base_url`, `youpi_merchant_id`, ... without a secret leaving
  the server. `youpiConfigured_()` and that list now share one implementation.
- the cash-only note says online is *not switched on for this event yet* instead
  of *temporarily unavailable*, which was only true for an outage, not for an
  unconfigured deployment.

The GitHub Pages build is also older than this repository's `script.js` (it
lacks `syncPaymentChoice`), so the live page behaves differently from Preview.
Updating it is a production deployment and was not done.

After the changes, `verify-apps-script.js` (**586 passed, 0 failed**) and
`verify-approve.js` (**80 passed**) were both rerun and passed.

---

## 4. What is *not* created (and why)

| Resource | Status | Reason |
| --- | --- | --- |
| Staging Google Sheet | **Not created** | Creating/copying a Sheet needs the owner's Google session; this workspace has no authorised Google Drive/Sheets tool and no service account |
| Staging Apps Script project/deployment | **Not created** | Same account requirement; `clasp` is installed but not signed in, and deploying a second project needs the organiser's Google account. The local build scaffold is prepared in `staging/` (see `staging/README.md`) |
| Public HTTPS host for YouPI | **Not created** | YouPI cannot run on GitHub Pages/Apps Script. A public tunnel or server is an external, irreversible exposure that requires explicit approval |
| Real YouPI merchant + receiving account | **Not configured** | The proposed `7075593104@fam` account belongs to a minor; FamApp eligibility and tournament use are unverified. The ID is deliberately not stored in this repository |
| Production deployment | **Not touched** | Out of scope for this task. GitHub Pages currently serves an older `script.js` than this repository (it lacks the "hide the online button while offline" logic), so the live page's offline behaviour differs from Preview. Updating it is a production deploy and needs your approval |

The production Sheet, production Apps Script deployment, its Script Properties
and the GitHub Pages site were not modified.

---

## 5. Steps that need the account holder

These are the only remaining steps; none of them can be performed from this
workspace without the organiser's Google session and a hosting decision.

### A. Create the staging spreadsheet (Google session required)

1. Open the production Sheet you already use for the event (its URL is in your
   own bookmarks; it is deliberately not written into this repository).
2. **File → Make a copy**. Name it `QQSGP STAGING — do not take payments`.
   The copy keeps the same tabs (`Registrations`, `PaymentDrafts`, `Audit`,
   `Settings`, `Notifications`) and formulas, but a different spreadsheet id.
3. In the **copy**, delete or blank any real team rows you do not want in
   staging, and note its id from the URL
   (`…/spreadsheets/d/<staging-id>/edit`).
4. Do **not** rename, move or share the production Sheet. Nothing in this
   repository writes to production unless its `/exec` URL is called.

### B. Create the staging Apps Script project (Google session required)

1. In the staging spreadsheet: **Extensions → Apps Script**. This creates a
   script **bound** to the copy (its own script id), not a copy of production.
2. Run `node staging/prepare-staging.js`, replace the default `Code.gs` with
   `staging/build/Code.js`, and use `staging/appsscript.json` for the manifest
   (Project Settings → *Show appsscript.json*). Details: `staging/README.md`.
3. In the staging script only: **Project Settings → Script Properties → Add**.
   Set `sheet_id` to the **staging** Sheet ID. A deployed web app has no active
   spreadsheet, so the fallback to the bound book is not relied on.
4. **Deploy → New deployment → Web app**: *Execute as* **Me**; *Who has access*
   **Anyone** (the public page must POST to it). Copy the `/exec` URL — that is
   the staging endpoint. Keep the production deployment untouched.
5. Open `…/exec?action=config` in a private window. Expect
   `{"ok":true,...,"online":false}` until step C is done. If it returns the
   production HTML or a login page, the deployment settings are wrong.

### C. Script Properties (staging project only, never in code)

| Property | Required | Meaning |
| --- | --- | --- |
| `youpi_base_url` | for online | Public HTTPS origin of the YouPI instance, no trailing slash |
| `youpi_merchant_id` | for online | Merchant UUID from the YouPI merchant admin |
| `youpi_merchant_key` | for online | That merchant's **webhook secret**; also sent as `X-Merchant-Key` |
| `youpi_min_verification_level` | optional | `0`, `1` or `2`; unset means **2** |
| `admin_key` | optional | Break-glass dashboard key; omit once every organiser has a PIN account |
| `sheet_id` | **yes** | Spreadsheet id of the staging Sheet; required by a deployed web app |
| `whatsapp_token`, `whatsapp_phone_number_id`, `whatsapp_verify_token` | for WhatsApp | Meta Cloud API credentials |
| `whatsapp_enabled`, `whatsapp_mode`, `whatsapp_api_version`, `whatsapp_template_lang`, `whatsapp_template_prefix`, `whatsapp_send_receipt`, `whatsapp_test_number` | optional | Behaviour and template naming; defaults are in `apps-script.js` |
| `org_accounts_v1`, `org_sessions_v1` | managed | Written by `setupSuperAdmin()` and the dashboard. Never hand-edit or copy between environments |

There are **no environment variables** in this project: it is static HTML plus
Apps Script, with no build step. `.env` is not read by anything here.

Do not paste any value into chat, GitHub, the Sheet, a frontend file or a
screenshot. Enter them directly in Project Settings. After saving, redeploy
(**Deploy → Manage deployments → edit → New version**) so the new properties
are read by the live deployment.

### D. Point a copy of the page at staging

1. Copy `script.js` and `index.html` to a scratch folder (do not edit the
   tracked files), and change only `APPS_SCRIPT_URL` in that copy to the staging
   `/exec` URL. `admin.js` needs the same change if you test the dashboard from
   that copy.
2. Serve the copy over HTTPS or `http://localhost` (Apps Script rejects some
   cross-origin POSTs from `file://`).
3. The production GitHub Pages site must keep pointing at the production `/exec`.

### E. Verify before trusting it

1. `…/exec?action=config` → `online:true`, expected `fee`, `provider:"YOUPI"`.
2. Register one synthetic team with Cash. Read the staging Sheet: exactly one
   row, `PENDING`, cash pending. Approve it, mark it paid, reload the Sheet and
   confirm both changes. Delete only that synthetic row when finished.
3. Change the fee in the dashboard, register another synthetic team, confirm the
   new row carries the new fee and the old row kept its own.
4. Only if a YouPI instance exists: open one online session, confirm the
   checkout URL is on your `youpi_base_url`, then cancel it. Do not pay.
5. Point the merchant's webhook at `<staging-exec-url>?action=paywebhook`.

### F. Do not push this repository's `.clasp-push/`

`.clasp-push/.clasp.json` currently names the **production** script id and its
`Code.js` is older than `apps-script.js`. A `clasp push` from there would
overwrite the live project. If you want clasp for staging, create a *separate*
folder with the staging script id; never edit `.clasp-push` for this.

Until C is complete, `?action=config` returns `online:false`; the page hides the
online button and explains that cash is still available.

### Receiving account (FamApp FamX)

- `7075593104@fam` is a **proposal**, not a verified merchant account.
- The holder is under 18: involve a parent/guardian and the college tournament
  organiser before any real collection.
- Do not assume that entering a UPI ID connects YouPI to it or verifies payment.
  YouPI needs its own merchant record, a receiving account and an observation
  channel (bank SMS device and/or Gmail) before it can verify anything.
- A FamApp/personal UPI **QR screenshot is not a YouPI integration**. Money sent
  to that QR never reaches YouPI, so the site cannot verify it and must not
  treat it as an online payment. Never publish the QR or the UPI id in this
  repository or the page.
- No real UPI ID is configured in the local staging database.

### Licence / authorisation

YouPI's repository has **no `LICENSE` file** and `package.json` says
`"license": "Commercial", "private": true`. Its README calls the project
experimental and not certified, bank-approved, NPCI-approved or audited. Obtain
written permission from the maintainers before running it for a real event, and
take the compliance question to the college organiser.

---

## 6. Staging acceptance checklist

Covered by the automated suites (`node verify-apps-script.js`, 599 checks;
`node verify-approve.js`, 80 checks):

- 2-, 3- and 4-player teams; invalid sizes rejected.
- Cash registration stays `PENDING`; organiser can mark it `PAID` with a note
  and an audit entry.
- Fee editing changes future orders only; an open draft keeps its snapshot.
- YouPI success, failure, cancel, expiry, wrong amount, wrong currency, wrong
  order, unknown token, duplicate callback, repeated poll, missing/null/empty/
  redacted `verificationLevel`, and a level below the minimum.
- `OBSERVED_SUCCESS` / `NOT_RECONCILED` stays pending and registers nobody;
  `RECONCILED` + `settlementState RECONCILED` at level 2 registers once, also
  when the reconciliation arrives after the checkout window.
- A forged webhook and a direct `ONLINE` claim register nobody.
- The merchant key is absent from every browser response and audit line.
- Approve/reject/waitlist and the WhatsApp prefill (manual send only).

Still requires the staged cloud resources or a phone:

- A staging Sheet actually receiving rows (isolation proof).
- A staging Apps Script deployment talking to YouPI.
- The hosted checkout through WhatsApp OTP, completed by a human payer.
- A real `SUCCESS` at level 2, reconciled against the receiving account.
- Any real-money run. **Not performed and not authorised.**

---

## 7. Commands used

```bash
# tests (no network, no Google account)
node verify-apps-script.js
node verify-approve.js

# local YouPI (separate clone)
cd F:/F_Temp/youpi/repo
node apps/payment-api/src/index.js
node apps/checkout-portal/src/index.js
curl http://127.0.0.1:6100/health
```

---

## 8. Re-verification — 4 November 2026

Read-only re-run of everything that does not need a Google session or a
payment. Full analysis: [PAYMENT-ARCHITECTURE.md](PAYMENT-ARCHITECTURE.md).

| Check | Result |
| --- | --- |
| `node verify-apps-script.js` | 586 passed, 0 failed |
| `node verify-approve.js` | 80 checks passed |
| Staging `/exec` via `staging/check-staging.js` | HTTP 403 — the deployment is still unauthorised and `sheet_id` is unset (manual Google step, §5a of `staging/README.md`) |
| Production `?action=config` | `online:false`, `provider:"YOUPI"`, `fee:100`, `minVerification:2` |
| Production `?action=stats` | 2 teams / 4 players, last entry 23 Oct 21:46 — unchanged |
| Real money moved | None |

Two contract drifts were found against the current YouPI clone
(`F:\F_Temp\youpi\verify`, commit `405327c`, not the `90eecd5` recorded above):

1. A real UPI payment now ends as `OBSERVED_SUCCESS` /
   `settlementState:"NOT_RECONCILED"`, not `SUCCESS`. `SUCCESS` is COD/counter.
   `apps-script.js:3264` treats anything except `SUCCESS` as still pending, so a
   level-2 payment would never register a team. It fails safe (no wrong row) but
   it does not complete. The suite passes because its fixture still answers
   `SUCCESS`.
2. `X-Merchant-Key` is checked against `merchants.api_key_hash`, which is the
   webhook secret only until an API key is rotated. After a rotation the Script
   Property must hold the `mk_live_…` key instead.

Neither was changed in that run: both alter what counts as a verified payment
and needed the organiser's decision. The local YouPI instance was not started,
so no new live contract calls were made.

---

## 9. Payment-status contract fix — 4 November 2026

The organiser approved the adapter correction; production payments remain off.
Reference source: YouPI commit `405327c`.

### What changed

`apps-script.js` now maps the current gateway contract as follows:

| Gateway answer | Draft | Page | Row |
| --- | --- | --- | --- |
| `OBSERVED_SUCCESS` / `NOT_RECONCILED` | `OBSERVED - AWAITING RECONCILIATION` | `PENDING` | none; audit `payment-observed` once |
| `RECONCILED` + `settlementState: RECONCILED` + exact order/amount/INR + level ≥ 2 | `FINALISED` | `PAID` | exactly one `ONLINE / PAID` |
| `RECONCILED` without `settlementState: RECONCILED` | unchanged | `PENDING` | none |
| `SUCCESS` (COD/counter/manual) | unchanged | `PENDING` | none |
| wrong order / currency / amount | `MISMATCH` | `REVIEW` | none |
| level below the minimum | `NEEDS REVIEW` | `REVIEW` | none, unless an organiser accepts |

A team whose credit has been observed is also blocked from opening a second
checkout, so an outstanding reconciliation cannot turn into a double payment.
A later `RECONCILED` answer finalises the same draft, including after the
checkout window. Replaying it returns the stored registration id.

### Merchant key

`X-Merchant-Key` is checked against `merchants.api_key_hash`. That hash is taken
from the webhook secret when the merchant has no explicit API key, so the webhook
secret works **until an API key is rotated**. After rotation the property must
hold the `mk_live_…` key, or every call answers `401 INVALID_MERCHANT_KEY`; the
adapter then reports a provider error, writes no row, and leaves the draft
`CREATING` so correcting the property and retrying reuses the same order id.

### Verification

| Check | Result |
| --- | --- |
| `node verify-apps-script.js` | **599 passed, 0 failed** (586 before; 13 new contract checks) |
| `node verify-approve.js` | 80 checks passed |
| New cases | observed → `PENDING`; inconsistent `NOT_RECONCILED` → `PENDING`; bare `SUCCESS` → `PENDING`; valid `RECONCILED` → `PAID`; wrong amount; wrong order; duplicate reconciliation; delayed reconciliation; rotated key |
| Production | untouched; `online:false` still |
| Real money moved | none |

The local YouPI instance was not started and no live contract call was made; the
new cases use the same mocked gateway transport as the rest of section 36.


