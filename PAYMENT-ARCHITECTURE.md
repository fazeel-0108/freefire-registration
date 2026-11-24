# PAYMENT ARCHITECTURE — Apps Script, one Node host, or more?

Status: **4 November 2026.** Investigation only. No backend was started, no
hosting was bought, no deployment or Script Property was changed, and no
payment was attempted.

Read with [PAYMENTS.md](PAYMENTS.md) (behaviour) and
[STAGING.md](STAGING.md) (what is actually running).

---

## 0. The answer

**Apps Script alone cannot host YouPI PG.** It is not a hosting limitation that
can be worked around: the gateway needs a listening process, a database, a
long-lived WhatsApp socket, two observers and inbound request headers. Apps
Script has none of those, and two of the five are security requirements rather
than conveniences.

**One small Node host is enough.** YouPI is one repository with one process
tree. Ports 6100, 7000 and 6003 are loopback listeners of the same application,
not three services to buy. A single ₹0–₹600/month host runs everything this
event needs, with one disk, one origin and one deploy.

**The status contract is now implemented (4 November 2026).** Two drifts were
found against the current YouPI code (§3): `SUCCESS` is no longer a UPI
outcome, and the merchant key is an API key that changes on rotation. The
adapter now pays only on `RECONCILED` + `settlementState: RECONCILED` at L2,
records `OBSERVED_SUCCESS` without registering anyone, and treats `SUCCESS` as
COD/counter. Production is still not enabled.

**Recommended:** keep the Google Sheets registration system and the Apps Script
merchant adapter exactly where they are; add one small always-on host for YouPI
(payment API + checkout + Gmail observer); keep the Android observer APK as the
SMS channel; require verification level 2; do not configure a webhook, because
Apps Script cannot verify its signature and polling is already authenticated.

---

## 1. What YouPI PG actually is

Measured from the clone at `F:\F_Temp\youpi\verify`, commit `405327c`
("Merge PR #137"), not from the older `90eecd5` recorded in PAYMENTS.md.

| Item | Value |
| --- | --- |
| Shape | npm-workspaces monorepo, ESM, 5 packages + 9 apps |
| Runtime | Node `>= 24.22.1` (`engines`), native `node:sqlite` |
| Root dependencies | none; each workspace declares its own |
| Payment-API dependencies | `@youpi/common`, `@youpi/core`, `@youpi/db`, `berryprotocol` 0.1.10, `qrcode` |
| Database | SQLite file (`USE_SQLITE_FALLBACK=true`, `./data/youpi_pg.sqlite`), WAL |
| Secrets on disk | `data/.secrets/` (admin token, observer token, encryption key) unless env vars are set |
| Process model | always-on; 1 s queue/expiry sweep, 1.5 s observer poll, 5 s webhook retry, SSE streams |
| Licence | `"license": "Commercial"`, `"private": true`, and **no `LICENSE` file** in the clone |

### Services and ports

| Service | Port | Needed for this event? | Why |
| --- | --- | --- | --- |
| `payment-api` | 6100 | **Yes** | REST API, state machine, SQLite, observers, webhooks |
| `checkout-portal` | 7000 | **Yes** | The hosted checkout page and its QR |
| `gmail-observer` | 6003 | **Yes for level 2** | Second observation channel |
| Android APK | – | **Yes** | Primary SMS/notification channel, HMAC-signed |
| `merchant-admin` | 6001 | Setup only | Creates the merchant, key and webhook; loopback |
| `sms-observer` | 6002 | No | Google Messages via Chrome CDP; the APK replaces it |
| `control-center` | 8090 | No | Process supervisor and log viewer |
| `coin-wallet-store` | 5000 | No | Demo storefront |
| `payment-help` | 3000 | No | Help pages |

Only 6100 and 7000 are meant to be publicly reachable. `payment-api` and
`gmail-observer` bind `127.0.0.1` by default (`YOUPI_BIND_HOST`), so 6003 is not
a public port at all. `scripts/start.js` runs in production mode only with a
Cloudflare domain, unless `YOUPI_MODE=localhost` is explicitly opted into with
`YOUPI_ALLOW_LOCALHOST_MODE=true`.

### What the gateway does that Apps Script cannot

- **Serve the checkout**: a listening HTTP server with server-authoritative
  timers, a single-slot FIFO queue and SSE. No Apps Script web app can be that
  origin, and Apps Script cannot hold a socket open.
- **Store state**: SQLite in WAL, transactional transitions, restart recovery.
  Sheet-as-database cannot preserve the one-active-slot invariant at a 1.5 s
  cadence, and Script Properties are capped at 9 KB per value / 500 KB total.
- **Hold WhatsApp**: `berryprotocol` keeps a multi-device WhatsApp session for
  pre-checkout OTP. It is a long-lived socket plus on-disk auth state.
- **Run observers**: a 1.5 s poller, a Gmail OAuth2 poller with a refresh token,
  and an Android observer that posts HMAC-signed payloads.
- **Read request headers**: `X-Merchant-Key`, `Authorization`, `X-Device-Id`,
  and `X-Gateway-Signature` are the whole authentication story.

## 2. Apps Script alone — possible?

No, for the gateway. Yes, for the merchant adapter, which is what it already is.

| Requirement | Apps Script capability | Consequence |
| --- | --- | --- |
| Public REST API with JSON | `doGet`/`doPost` only | Cannot implement the API surface other services call |
| Listening port / long-lived process | None; 6 min per execution, 90 min/day of trigger runtime on a consumer account (6 h on Workspace) | No daemons, no queue sweeps, no SSE |
| SQLite / persistent FS | None; Sheets + Properties | No transactional queue, no WAL recovery |
| Inbound headers | Not exposed to `doPost` | **Cannot verify YouPI's HMAC webhook**, nor the Android observer's signature |
| WhatsApp socket (Baileys/Berry) | None | No gateway-owned OTP gate |
| Chrome/CDP for Google Messages | None | No SMS-observer substitute |
| Gmail access | **Yes** — `GmailApp`, using the script owner's own OAuth | Only genuinely portable piece (§3, option B) |
| Outbound HTTPS | `UrlFetchApp` — 20,000 calls/day consumer, 100,000 Workspace | Enough for a college event's adapter traffic |

The project already documents the decisive one: *"Apps Script cannot read
request headers, so no signature is checked there."* That is acceptable for a
doorbell that re-reads the gateway with the merchant key. It is **not**
acceptable as the gateway's own webhook endpoint, because YouPI's contract is
`X-Gateway-Signature` over the raw body plus `X-Gateway-Signature-V2` over
`<timestamp>.<body>`, with `X-Gateway-Delivery-Id` for dedupe.

### 2a. The Gmail observer in Apps Script — technically yes, recommended no

It could be done: a time-driven trigger calls `GmailApp.search()` on the
bank-alert sender, extracts the amount and UTR, and POSTs to
`/api/v1/pollers/events` with `Authorization: Bearer <observer token>`,
`source: "GMAIL"` and the raw alert text. That is a real endpoint
(`pollers.routes.js`), and it would count toward level 2.

Reasons not to:

- It re-implements YouPI's security-critical parsing (bank-domain allowlist,
  MIME walking, amount/UTR normalisation, dedupe). A wrong parse here is a
  wrong payment decision, and it would live outside the audited code.
- The observer bearer token is effectively a god-token: it can inject an
  observation for any receiving account. Putting it in a Google-hosted script
  widens the blast radius for no architectural gain.
- Trigger granularity is one minute at best, with a 90 min/day cap; a paid
  checkout that waits on a one-minute poll is worse UX than the current 1.5 s
  loop.
- It saves one loopback process on a host that is running anyway. It does not
  remove the host, the database, the checkout or the WhatsApp socket.

**Verdict:** keep `gmail-observer` on the Node host. It is the cheapest part of
the deployment.

## 3. Contract drift found, and how it was resolved

Both drifts were real and both failed safe. Neither is a security bypass. Both
are now implemented in the adapter and covered by tests.

### 3.1 `SUCCESS` is no longer the UPI outcome

The current clone separates observation from settlement:

- `POST /api/v1/payments` returns `status: "INITIATED"`; the customer must
  authenticate in the checkout before a slot and timer exist.
- An observed bank credit produces `OBSERVED_SUCCESS` with
  `settlementState: "NOT_RECONCILED"` (`toPublicOutcome` keeps the distinction;
  it does **not** map it to `SUCCESS`).
- `RECONCILED` is produced only by an operator statement import or an admin
  confirmation of an `OBSERVED_SUCCESS`/`MANUAL_REVIEW` session.
- `SUCCESS` now means COD/counter/manual, not UPI.

`apps-script.js` line 3264 is:

```js
if (status !== 'SUCCESS') return { state: 'PENDING', paymentStatus: status };
```

Before the fix, a real level-2 UPI payment returned `OBSERVED_SUCCESS` and the
adapter polled forever without registering anybody. The suite passed because its
gateway fixture still answered `SUCCESS`; it encoded the old contract, so it
could not catch this.

**Implemented:** the adapter accepts only `RECONCILED` + `settlementState:
"RECONCILED"` as payable, at the required verification level. An
`OBSERVED_SUCCESS` / `NOT_RECONCILED` reply is written to the draft as
`OBSERVED - AWAITING RECONCILIATION`, returns `PENDING`, registers nobody,
blocks a second checkout for that team, and is audited once as
`payment-observed`. A later `RECONCILED` reply finalises the same draft, even
after the checkout window. `SUCCESS` is treated as COD/counter and never pays an
online entry. The fixtures were moved to the current contract.

### 3.2 The merchant key is an API key, not necessarily the webhook secret

`POST /api/v1/payments` requires `X-Merchant-Id` and a valid `X-Merchant-Key`,
checked against `merchants.api_key_hash`
(`packages/db/src/repositories/merchant.repository.js:173`). On the default
creation path the stored hash is taken from the webhook secret when no API key
is supplied (`:67`), so the current Script Property works **until an API key is
rotated** — at which point `api_key_hash` becomes `mk_live_…` and the webhook
secret stops authenticating. `youpi_merchant_key` must therefore hold whichever
value currently hashes to `api_key_hash`: the merchant API key (`mk_live_…`),
which is the webhook secret only for a merchant that never rotated one.

After rotation, create and status calls answer `401 INVALID_MERCHANT_KEY`. The
adapter surfaces that as a provider error, writes no row, and leaves the draft
`CREATING`, so correcting the Script Property and retrying reuses the same order
id. A test asserts that path.

## 4. Is one small service sufficient?

**Yes — one host, one process tree, three listeners.**

```
             ┌─────────────────────────────────────────────┐
Apps Script ─┤ 443  reverse proxy / Cloudflare Tunnel       │
 (Sheets,    │      /api/*    → 127.0.0.1:6100             │
  fee,       │      /checkout → 127.0.0.1:7000             │
  adapter)   │                                             │
             │  127.0.0.1:6003  gmail-observer             │
             │  data/           SQLite + secrets + dedupe  │
             └──────────────┬──────────────────────────────┘
                            │ HMAC observation (HTTPS)
                  Android APK on the receiving SIM phone
```

- Ports 6100 and 6003 are loopback; only the proxy is public. "6100 and 6003"
  is one bill, not two.
- `payment-api` exposes `createPaymentApp().rawServer`, and `gmail-observer`
  exposes `createServer()`; both are plain `http.Server`s, so a single entry
  point can listen on both ports in one process. The supported alternative is
  YouPI's own `scripts/start.js` supervisor in one container.
- Skip `merchant-admin`, `control-center`, `coin-wallet-store` and
  `sms-observer` for the event. Run `merchant-admin` on loopback once, to create
  the merchant, then close it.
- One process is a single point of failure; use a restart policy (systemd,
  Docker `restart: unless-stopped`, or the host's process manager).
- Sizing: 1 vCPU / 512 MB–1 GB RAM and 1–2 GB disk is ample for a college
  event, well inside YouPI's own 20-payments-per-day experimental guidance.
  SQLite plus the OAuth token must survive restarts, so ephemeral filesystems
  are disqualified.

## 5. Options compared

| | Apps Script only | Apps Script + one Node host (recommended) | Fully separate services |
| --- | --- | --- | --- |
| Hosts the gateway | No | Yes | Yes |
| Signature verification | Impossible (no headers) | Yes, on the Node side; Apps Script polling is authenticated by merchant key | Yes |
| Level 2 (SMS + Gmail) | Impossible (no observers/socket) | Yes | Yes |
| Sheets registration | Yes | Yes (unchanged) | Yes (unchanged) |
| Moving parts | 1 | 2 (Apps Script + 1 host) | 4–8 |
| Recurring cost | ₹0 | ₹0–₹600/month | Same as one host; ports are loopback |
| Reliability | Google-grade for the adapter, no gateway | One restart policy to run | More to monitor, same single point of failure unless replicated |
| Security surface | N/A — cannot work | One public origin, observers loopback, one key store | Larger: more exposed admin/observer surfaces |

Cost detail, to be confirmed at purchase time and **not bought here**:

- Oracle Cloud Always Free ARM VM, or an existing always-on PC with a free
  Cloudflare Tunnel: ₹0 recurring, but the free tier can reclaim capacity and a
  home PC carries power and uptime risk.
- Small paid VPS / Fly.io / Railway / Hetzner-class host: roughly ₹350–₹600 per
  month as of late 2026.
- Render's free web service is **not** suitable: it spins down and its disk is
  ephemeral, which breaks SQLite continuity and the observer loop.
- A domain, if you want a stable origin: ~₹900/year. A Cloudflare Tunnel
  hostname avoids buying one.

## 6. Recommended lowest-cost secure architecture

1. **Keep** the Google Sheets registration system, the dashboard, and the Apps
   Script deployment exactly as they are. Its role is: fee, drafts, row writing,
   organiser review, audit. It is a merchant client, not a gateway.
2. **One small Node host** runs `payment-api` (6100), `checkout-portal` (7000)
   and `gmail-observer` (6003) on one disk, behind one HTTPS origin. Only
   `/api/*` and `/checkout/*` are proxied; observers stay on loopback.
3. **Android observer APK** on the phone holding the receiving SIM is the
   primary SMS channel; **Gmail OAuth** on the same host is the second channel.
   Level 2 is required; a level-1 or Gmail-only observation is held for an
   organiser and never registers a team.
4. **No webhook.** Apps Script cannot verify `X-Gateway-Signature`, so do not
   configure a merchant webhook URL. `paystatus` polls the gateway with the
   merchant key — an authenticated server-to-server read — which is stronger
   than an unverified callback and avoids the requirement in §2 being waived.
   If a webhook is ever wanted, it must terminate on the Node host, not on
   Apps Script.
5. **Never treat a Gmail, SMS or FamPay notification as proof by itself.** The
   bank-alert allowlist inside YouPI rejects senders outside its domain list; a
   FamApp/FamPay notification from its own domain cannot enter the pipeline.
   The adapter additionally requires `verificationLevel >= 2`.
6. **Reconcile daily** against the bank statement. YouPI itself says an
   observation is not settlement; `OBSERVED_SUCCESS` is explicitly
   `NOT_RECONCILED`. Keep the organiser review queue for anything ambiguous.
7. **Before enabling online**, reconcile daily and complete one real ₹1 test
   once the licence, merchant and observers exist. The status contract is
   implemented (§3): payable means `RECONCILED` + `settlementState RECONCILED`
   at level >= 2; `OBSERVED_SUCCESS` stays pending; `SUCCESS` is COD-only.

## 7. Authorizations you must give

Nothing below has been requested from a third party or purchased.

| # | Authorization | Needed for |
| --- | --- | --- |
| 1 | Written licence/permission from YouPI's maintainers | Running it at all; no `LICENSE` file, `"Commercial"` in `package.json` |
| 2 | Choice of host and approval of any spend (₹0 tier vs ~₹600/month) | Creating the one Node host |
| 3 | Public HTTPS origin (tunnel hostname or domain + DNS) | Checkout and API reachability from Google's servers |
| 4 | Merchant bound to the real receiving account, with the account holder's consent (holder is a minor — guardian and college organiser involved) | Payments reaching your account |
| 5 | The merchant API key / webhook secret, typed into Script Properties only | Adapter authentication; never in chat or a tracked file |
| 6 | Google OAuth client for the Gmail observer (client ID, secret, redirect URI) | Level 2 |
| 7 | The Android phone with the receiving SIM, APK installed and paired | SMS channel |
| 8 | College/bank confirmation that collecting entry fees this way is acceptable | Compliance |
| 9 | Approval to deploy the adapter change in §3 and to publish anything | Production |
| 10 | Authorising the staging Apps Script (Google consent + `sheet_id`) | Turning the 403 staging endpoint into a usable test target |

## 8. Verification run — 4 November 2026

| Check | Result |
| --- | --- |
| `node verify-apps-script.js` | **599 passed, 0 failed** (586 before this change; 13 new contract checks) |
| `node verify-approve.js` | **80 checks passed** |
| Staging `/exec` (`staging/check-staging.js`, GET only) | **HTTP 403** — 1 passed, 4 failed, 2 warnings. The deployment exists but has not been authorised and `sheet_id` is not set; this is the manual Google step in `staging/README.md §4a`. |
| Production `?action=config` (read-only) | `online:false`, `provider:"YOUPI"`, `fee:100`, `minVerification:2` — unchanged |
| Production `?action=stats` (read-only) | 2 teams / 4 players, last entry 23 Oct 21:46 — unchanged |
| Live YouPI call | **None.** The instance was not started; no real payment was attempted. |
| Codes changed | `apps-script.js` (status contract) and `verify-apps-script.js` (fixtures + 13 checks). No production resource was touched. |

The two findings the old fixtures could not see — §3.1 (a real UPI payment now
answers `OBSERVED_SUCCESS`) and §3.2 (a rotated merchant API key replaces the
webhook secret as `X-Merchant-Key`) — are now covered by the 599-check suite.
The full transition is in §10.

## 9. What was not done

- No second backend, service, tunnel, container or host was started.
- No hosting, domain or paid resource was purchased.
- No production Script Property, deployment, Sheet, fee or site was changed.
- No credential, key, UPI ID or Sheet ID was read into this document.
- No real payment, refund or test-mode settlement was performed.
- No frontend was published.
- No production payments were enabled: `online` still depends on the merchant
  properties, and the adapter change alone does not switch anything on.

## 10. The payment-state transition, and the tests that prove it

`verifyYoupiPayment_` reads one merchant-authenticated `GET /api/v1/payments/:id`
and maps it as follows. The first matching row wins.

| Gateway answer | Adapter outcome | Draft | Registration row |
| --- | --- | --- | --- |
| no `verificationLevel` | `MISMATCH` / identity | `IDENTITY MISMATCH` | never; not in review queue |
| `FAILED` / `EXPIRED` / `CANCELLED` | same | closed | never |
| `OBSERVED_SUCCESS` (any settlement state) | `OBSERVED` | `OBSERVED - AWAITING RECONCILIATION` | **never**; audit `payment-observed` once |
| `RECONCILED` + settlement ≠ `RECONCILED` | `PENDING` | unchanged / observed | never |
| `RECONCILED` + settlement `RECONCILED`, non-UPI method | `PENDING` | unchanged | never |
| `RECONCILED` + settlement `RECONCILED`, wrong order / currency / amount | `MISMATCH` | `MISMATCH` | never; organiser review |
| `RECONCILED` + settlement `RECONCILED`, level below minimum | `UNVERIFIED` | `NEEDS REVIEW` | never; organiser may accept |
| `RECONCILED` + settlement `RECONCILED`, exact order/amount/INR, level ≥ minimum, UPI | `PAID` | `FINALISED` | **exactly one** `ONLINE` / `PAID` row |
| `SUCCESS` or `MANUAL_REVIEW` | `PENDING` (unreconciled) | unchanged | never |
| `INITIATED` / `QUEUED` / `ACTIVE` / `PROCESSING` | `PENDING` | unchanged (EXPIRED once its own window passes) | never |

Consequences that matter:

- `PAID` requires **both** independent observers (level 2 by default) **and**
  reconciliation. Neither satisfies it alone.
- An observed credit freezes the attempt: the team is told `PENDING`, cannot open
  a second checkout, and the same draft is finalised when the statement catches
  up — including after the checkout window closed.
- Replaying a `RECONCILED` poll or callback returns the stored registration id
  and writes nothing; the finalise step is idempotent under the script lock.
- The page's contract is unchanged: it still polls `paystatus` and understands
  `PENDING` / `REVIEW` / `PAID` / `CANCELLED` / `EXPIRED`, so no frontend change
  was needed.

Proof in `verify-apps-script.js` (section 36, 599 checks, 0 failed):

| Requirement | Test names |
| --- | --- |
| `OBSERVED_SUCCESS` without reconciliation stays `PENDING` | "an observed level-2 credit stays PENDING, not PAID"; "an observed credit registers no team"; "the draft records the observation without finalising it"; "polling the observation again is idempotent" |
| `NOT_RECONCILED` stays `PENDING` | "RECONCILED without settlementState RECONCILED stays PENDING" |
| `SUCCESS` is not payment | "a bare SUCCESS never registers an online team" |
| `RECONCILED` + valid order/amount follows the verified `PAID` transition | "a RECONCILED level-2 payment registers the team"; "exactly one row was written"; "the row is ONLINE / PAID" |
| Wrong amount | "a RECONCILED payment for the wrong amount is refused"; "the wrong amount registers no team" |
| Wrong order id | "a payment for another order is refused"; "another order registers nobody here" |
| Duplicate reconciliation is idempotent | "replaying the reconciliation returns the same registration"; "replaying the reconciliation writes no second row" |
| Invalid / rotated merchant credentials | "a rejected merchant key is reported, not faked"; "invalid or rotated credentials leave only a retryable draft" |
| Delayed reconciliation | "a delayed reconciliation after the checkout window still registers the team"; "the late-reconciled row is ONLINE / PAID at the snapshotted fee" |
| L2 still enforced | "a level-1 payment is not accepted at the configured level 2"; "a weakly verified payment registers no team" |
| Owner-only identity still enforced | the four "IDENTITY MISMATCH" checks and the genuine level-2 control |

