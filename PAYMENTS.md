# PAYMENTS — ₹ entry fee, verified online

Two methods, never mixed, and one gateway in front: **YouPI PG**, self-hosted
by the organiser. It is the only online gateway in this codebase — there is no
second provider to fall back to, and no Razorpay call anywhere in the active
flow. Historical rows that name Razorpay are left exactly as they are, so old
records stay auditable.

Last reviewed: 21 October 2026.

---

## 1. What is implemented

| Team chooses | What happens | Row written |
| --- | --- | --- |
| **Online** | The server opens a YouPI session for the live fee. The page embeds YouPI's own hosted checkout. The server polls YouPI with the merchant key; only a payment it reports as `SUCCESS`, in INR, for the exact snapshotted fee, against the session it opened, at the required verification level, writes the row. | `ONLINE` / `PAID` + order id, payment id, paid amount, currency, verified time, provider |
| **Cash** | The row is written immediately and stays `PENDING` until an organiser has the notes in hand and marks it paid. | `CASH` / `PENDING` |

There is no "I have paid" button anywhere. A registration that claims
`ONLINE` is refused by the backend (`validatePaymentChoice_`), so posting the
form directly, editing the page or replaying a request cannot create a paid
team.

### Flow, end to end

```
form ──► POST ?action=payorder   validate, snapshot fee, persist a draft (CREATING), then open a session
                  │
                  ▼
        gateway UI shown, page polls ──► POST ?action=paystatus (token)
                                              │
                                    GET the session back WITH the merchant key
                                              │
                 status = SUCCESS + exact order + exact amount + INR
                 (+ YouPI verification level >= configured minimum)
                                              ▼
                                one row written under a script lock
                                draft FINALISED · audit payment-verified
```

`POST ?action=paywebhook` is the gateway's callback. Apps Script cannot read
request headers, so **no signature is checked there**: the body is used only to
find the draft, then the server asks the gateway directly. A forged callback
full of `"event": "SUCCESS"` registers nobody.

### Server actions

| Route | Purpose |
| --- | --- |
| `?action=config` (GET) | live fee, currency, provider, whether online is configured, required verification level |
| `?action=payorder` | validate form, snapshot fee, persist a draft, open a session; a retry reuses the same draft |
| `?action=paystatus` | poll: ask the gateway, finalise when paid, report `PENDING` / `PAID` / `REVIEW` / `EXPIRED` / `CANCELLED` |
| `?action=paycancel` | cancel the draft, best-effort close the session at the gateway |
| `?action=paywebhook` | gateway callback (doorbell only) |
| `?action=admin` → `settings-get` / `settings-set` | read/change the live fee, see the gateway |
| `?action=admin` → `drafts-list` / `draft-resolve` | the review queue and the organiser's decision |

### Sheet changes (append-only)

`Registrations` keeps its 20 existing columns and gains six on the right:

`Payment Order ID`, `Payment ID`, `Paid Amount`, `Paid Currency`,
`Payment Verified At`, `Payment Provider`

New tabs:

- **Settings** — `entry_fee` (one row, `Key`/`Value`/`Updated At`/`Updated By`).
- **PaymentDrafts** — one row per attempt: token, expiry, team + players JSON,
  fee snapshot, order id, status, payment id, registration id, and (new)
  `Provider`, `Checkout URL`, `Verification`. The legacy `QR ID` / `QR Image
  URL` columns stay in the schema, empty, so an older sheet is widened rather
  than reshaped. An older tab is widened and its header row extended on first
  use, so nothing is inserted or moved.

  A draft is written with status `CREATING` *before* the gateway is called and
  flipped to `OPEN` once the session exists, so a create that times out is
  retried with the same token and order id instead of minting a second order.

`Audit` gains `payment-opened`, `payment-verified`, `payment-unverified`,
`payment-mismatch`, `payment-cancelled`, `payment-no-slot`,
`payment-manual-accept`, `payment-rejected`, `settings-fee`.

### Guardrails

- The fee is snapshotted when the session opens and copied onto the row;
  changing the fee later never rewrites an existing registration.
- Amount, currency and order id must all match, or the attempt is held as
  `MISMATCH` for an organiser instead of registering a team.
- YouPI payments below the configured verification level are held as
  `NEEDS REVIEW`; no team is registered until a human accepts them.
- Duplicate callbacks and repeated polls return the same registration id; the
  finalise step runs under `LockService` and re-reads the draft first.
- A create that times out leaves the `CREATING` draft in place: the next
  attempt reuses the same token, so the deterministic order id makes YouPI
  return the session it already opened rather than creating a competing one.
  The retry sends the draft's own fee snapshot, never today's fee. Two clicks
  arriving together converge on one draft, because the token is minted and
  persisted under the script lock.
- If the event filled up or the name was registered between opening the session
  and paying, the money is recorded (`PAID - NO SLOT`) and audited.
- No secret reaches the browser: keys are read from Script Properties inside
  the provider call and appear in no response, sheet cell or audit line.

---

## 2. Gateway configuration

Everything is deployment configuration in **Script Properties**:

| Property | Values |
| --- | --- |
| `youpi_base_url` | public base URL of your YouPI instance, e.g. `https://pay.example.org` |
| `youpi_merchant_id` | the merchant UUID from YouPI's merchant admin |
| `youpi_merchant_key` | that merchant's **webhook secret** (YouPI also accepts it as `X-Merchant-Key`) |
| `youpi_min_verification_level` | `0`, `1` or `2`; default **2** |

Until those properties exist, the page says *"Online payment is not switched
on yet"* and **Cash still works**. It never pretends to verify a payment it
cannot verify.

Razorpay settings left over from an older deployment are ignored: a
`payment_provider` or `razorpay_key_*` property cannot switch anything on, and
the backend has no code that could create a Razorpay order. Delete those
properties when convenient; nothing depends on them.

### YouPI PG setup (self-hosted)

YouPI is not a hosted service. You run it, so you also run the infrastructure:

1. **Licence first.** The repository has *no* `LICENSE` file and
   `package.json` says `"license": "Commercial", "private": true`. Get written
   permission from the maintainers before running it for a real event.
2. **A host**: Node ≥ 24 with a persistent process and a public HTTPS origin.
   GitHub Pages / Apps Script cannot host it. `npm install && npm start`, then
   set `BASE_PAYMENT_API_URL`, `BASE_CHECKOUT_URL`, `DATABASE_URL` (or SQLite),
   `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, `CHECKOUT_FRAME_ANCESTORS`.
3. **The observer phone.** YouPI decides whether money arrived by reading the
   receiving account's **bank SMS** (Android observer APK on the phone holding
   the SIM), plus **Google Messages Web** and a **Gmail OAuth poller** as the
   second channel. Without at least the SMS channel, nothing is ever verified.
4. **A merchant**: run the merchant admin (port 6001), create the merchant,
   note its UUID and webhook secret, and point its webhook at
   `.../exec?action=paywebhook`.
5. **Script Properties** in Apps Script: `youpi_base_url`,
   `youpi_merchant_id`, `youpi_merchant_key`
   (optionally `youpi_min_verification_level`).
6. **Redeploy the web app** and run one ₹1 test payment end to end: the
   checkout must appear inside the panel, the row must appear only after
   YouPI answers `SUCCESS` with level ≥ the configured minimum.

Two more things the organiser must accept:

- **The checkout is YouPI's page, not a bare QR.** The panel embeds
  `checkoutUrl` (with an "open in a new tab" button on phones, where a 225 px
  iframe is unusable). It cannot be reduced to a QR-only screen, because the
  QR lives inside that page.
- **Verification is bank-alert based.** YouPI's own README says its status is
  "not by itself conclusive proof of settlement" and asks you to reconcile
  against the bank. Level 2 means *both* observers agreed — better, still not a
  bank API. That is why level 1 is held for a human rather than registered.

---

## 3. Verified by tests

`node verify-apps-script.js` — **556 checks**, including:

- section 35 (no second gateway): a leftover `payment_provider=razorpay` and
  Razorpay keys leave online payment off, open no session, call no gateway,
  and the backend exposes no Razorpay helper at all.
- section 36 (YouPI): page told the gateway and required level; merchant key
  sent as a header and never in the URL or the response; order id generated by
  us and an answer about another order refused; `PENDING` writes no row;
  forged webhook with a full `SUCCESS` body refused; level 1 held as
  `NEEDS REVIEW` and audited; wrong amount and wrong order refused; level 2
  registers once with provider, session id, amount, currency, timestamp and a
  note that names the level; duplicate callback adds no team; cancel calls
  `/checkout/{id}/cancel`; organiser accept needs a note, writes one row,
  records who accepted and why, and is idempotent; reject saves nobody; the
  required level is read from Script Properties; cash stays `PENDING`; an
  `ONLINE` claim is still refused.

`node verify-approve.js` — **54 checks**; the WhatsApp approval message quotes
the fee stored on the row, not a constant.

**Live gateway contract** — YouPI PG V2 was cloned, installed on Node 24 and
run locally (`payment-api` on :6100, SQLite). The exact requests this adapter
sends were replayed against it:

| Call | Result |
| --- | --- |
| `POST /api/v1/payments` with `X-Merchant-Key`, amount `100.00` | `201` with `paymentId`, `orderId` echo, `amountPaise 10000`, `currency INR`, `checkoutUrl` |
| `GET /api/v1/payments/{id}` with `X-Merchant-Key` | `200` with `status`, plus `verificationLevel`, `verificationTag`, `internalStatus` |
| Same GET **without** the key | `200` but **no** verification fields — a leaked session id cannot read them |
| Same POST with a wrong key | `401 INVALID_MERCHANT_KEY` |
| `POST /api/v1/checkout/{id}/cancel` | `200 CANCELLED`, and the next status read says `CANCELLED` |
| A session seeded `SUCCESS` with level 2 | owner view returns `SUCCESS`, `verificationLevel 2`, `DUAL_VERIFIED` — the evidence the adapter requires |

**Browser** (preview harness): the hosted checkout is framed, there is no
submit button; the stand-in gateway click is
discovered by polling (no page button), the panel reaches *Registered & Paid*,
a level-1 answer stops at the review message with no row, a double gateway
click registers once, cash stays pending, and a direct `ONLINE`/`PAID` POST is
refused. Desktop 1280×900 and phone 390×844 checked (no horizontal overflow;
the frame is replaced by a full-width button on phones).

**Not tested:** a real merchant account on a public YouPI instance and a real
UPI payment through it. Those need the credentials and the observer phone
described above; nothing in this repository claims otherwise. The deployed
Apps Script itself has been exercised (`?action=config` and `?action=stats`),
and it reports online payment as off while the properties are missing.

---

## 4. YouPI PG — what it actually is

Repository: <https://github.com/youpi-pg/YouPI-PG> (clone inspected 21 Oct 2026,
commit `90eecd5`).

**It is real software with a real public API** — this is not a mock-up:

- `POST /api/v1/payments` → `paymentId`, `checkoutUrl`, amount echo
- `GET /api/v1/payments/{id}` → status, and for the owning merchant
  `verificationLevel` (0 unverified, 1 SMS observed, 2 SMS + Gmail)
- `POST /api/v1/checkout/{id}/cancel`
- HMAC-SHA256 webhooks (`X-Gateway-Signature: sha256=…`), test mode and a
  simulator for synthetic bank messages
- 8 services: payment API 6100, checkout 7000, merchant admin 6001, control
  centre 8090, Gmail observer 6003, SMS observer 6002, demo store 5000

It is also, in its own words, **a research project**:

> "not represented as a certified, bank-approved, NPCI-approved, audited, or
> production-ready payment gateway … Do not use it as the sole source of truth
> for payment confirmation."

and it carries `"license": "Commercial"` with **no licence file in the repo**.

### Is it suitable for this tournament?

Only if you accept all of this:

| Question | Answer |
| --- | --- |
| Can it take a UPI payment? | Yes, through its own hosted checkout on your server. |
| Can this site verify it server-side? | Yes — merchant-key `GET` returns the session outcome and verification level. The adapter does exactly that. |
| Is that as strong as a PSP? | **No.** Confirmation comes from bank SMS / Gmail parsing by a project that warns against relying on it. Level 2 (two independent observers) is the strongest signal it offers. |
| Does the 0% fee apply to me? | It means **no aggregator fee**: money moves P2P into your own UPI account. It is not a verified 0% for a college event — you still carry bank risk, reconciliation work and compliance responsibility, and the project's README asks experimenters to keep usage to **20 or fewer payment attempts per day per receiving account**. |
| Can it run where this site runs? | No. GitHub Pages + Apps Script cannot host a Node monolith, SQLite, an Android observer or a Gmail poller. You need a separate host and a phone with the receiving SIM. |
| Is the licence sorted? | Not by the repository. Ask the maintainers in writing before a real event. |

So: **integrated, but off until configured**, and set to require level 2. If
any of the setup above is missing, online stays dark and cash keeps working.
That is the honest state: the adapter is exercised against a locally hosted
YouPI instance, not against a live merchant with a real phone — see §3.

Razorpay is gone from the code. The six payment columns and any row that names
`RAZORPAY` in `Payment Provider` are untouched, so historical records still
read correctly in the dashboard and in an export.

---

## 5. Backups

- `backup/qqsgp-before-payments.zip` — the repository at commit `756664b`,
  before the payment rewrite.
- `backup/apps-script.js.with-verified-payments` — the backend as it stood
  before YouPI support was added.
- `backup/apps-script.js.with-youpi` — the backend after this change.
- `backup/working-changes.patch`, `backup/working-changes-with-youpi.patch` —
  the diffs.
- Register data: the dashboard's **Export CSV** writes every row, and the sheet
  schema is append-only, so an older copy of the script keeps reading new rows.
  A copy of the sheet itself is a File → Make a copy in Google Sheets; that is
  the organiser's action, not something this repository can do.

`backup/` is git-ignored: it is a local safety net, not a published artifact.
