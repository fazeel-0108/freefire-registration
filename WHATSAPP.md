# WhatsApp notifications — setup, templates and operations

The site can message team leaders on WhatsApp through the **official WhatsApp
Business Cloud API** (Meta). Nothing here automates WhatsApp Web or a personal
session: the backend calls `graph.facebook.com` with a token that only the
server holds.

**Current state:** the code, the consent capture, the notification log, the retry
path, the announcement composer and the webhook are implemented and tested
against a mocked provider (see §9). **No message has been sent from your account**
— the credentials below do not exist yet, so the module is switched off and
every attempt is refused rather than faked.

**Approving a team does not depend on any of this.** The dashboard's *Approve*
button saves the status and then opens WhatsApp click-to-chat with the approval
message already typed, addressed to the team leader's number — you just press
Send. That is manual messaging, needs no Meta account, and is what runs today.
The Cloud API described below is the optional fully-automated upgrade.

---

## 1. What happens when

| Moment | What the server does |
| --- | --- |
| A team submits the form | Saves the row with `PENDING`, plus the WhatsApp consent answer and its timestamp. Sends nothing (unless you switch on the optional receipt). |
| You approve | Saves the status **first**, then opens WhatsApp with the message pre-filled (`wa.me`, click-to-chat). You press Send. Nothing is sent by the server. |
| You reject / waitlist | Saves the status **first**. With the Cloud API on, that also creates one notification row and submits one template message; a notification failure never changes the status. |
| Meta accepts the message | State `SENT` — "accepted by the provider". Not "delivered". |
| Meta reports delivery | Webhook moves the row to `DELIVERED`, then `READ`. Late or repeated events never move it backwards. |
| Meta rejects it | `FAILED` with the provider's reason, and a **Retry** button. |
| The connection dies mid-send | `UNCERTAIN` — the message may have arrived. Retrying asks for confirmation first. |
| No consent / no valid number | `SKIPPED` with the reason. Nothing is sent, ever. |
| You send an announcement | Preview → recipient count → confirm → one message per recipient, with the same ids reused for 10 minutes so a double click cannot double-send. |

## 2. Turn it on

1. **Script Properties** (Apps Script → Project Settings → Script Properties).
   Add these names. Values stay on the server; they are never in the repo.
   | Property | Value |
   | --- | --- |
   | `whatsapp_enabled` | `yes` (anything else leaves the module off) |
   | `whatsapp_token` | the Cloud API access token |
   | `whatsapp_phone_number_id` | the sending number's **Phone number ID** (not the number itself) |
   | `whatsapp_verify_token` | a long random string **you invent** (used by the webhook) |
   | `whatsapp_api_version` | optional, default `v21.0` |
   | `whatsapp_template_lang` | optional, default `en` |
   | `whatsapp_template_prefix` | optional, default `qqsgp` |
   | `whatsapp_send_receipt` | `yes` to also send the optional "entry received" message |
   | `whatsapp_test_number` | your own number, for `sendTestWhatsApp()` |
2. Run **`whatsappStatus()`** in the editor. It prints only *whether* each value
   is set — never a value.
3. Run **`sendTestWhatsApp()`**. It sends one real message and prints the result.
4. Open the dashboard: the panel header must say *Connected · approved templates*.

Turning it off is one property: set `whatsapp_enabled` to `no`. Status changes
keep working and no notification rows are created.

## 3. Getting the credentials (Meta side)

This part needs your Facebook account; it cannot be done from the code.

1. Go to <https://developers.facebook.com/> and sign in.
2. Create an app (type *Business*) or open an existing one, then add the
   **WhatsApp** product.
3. In **WhatsApp → API Setup** you get a temporary token, a **test number** and
   its **Phone number ID**. Add your own number under *To* as a test recipient.
4. Copy the Phone number ID and the token into the Script Properties above and
   run `sendTestWhatsApp()` — this proves the wiring before anything else.
5. For real sending you need a **WhatsApp Business Account** with a verified
   business and your own display number (Business settings → Account setup).
   The temporary token expires after 24 hours; create a **System User** token
   with `whatsapp_business_messaging` permission for production, or a permanent
   token from Business Settings → System users.
6. Submit the message templates in §4 for approval. Proactive messages are only
   allowed through **approved templates** — that is Meta's rule, not this code's.
7. Paste the permanent token into `whatsapp_token` and set
   `whatsapp_enabled` to `yes`.

Never paste a token into `apps-script.js`, `admin.js`, a commit or a screenshot.
If a token is ever exposed, revoke it in Meta and issue a new one.

## 4. Message templates to submit

Create these in **WhatsApp Manager → Account tools → Message templates**, category
**Utility**, language **English (en)**. The name must match what the code asks
for — the default names are below, and each can be overridden with a Script
Property (`whatsapp_tpl_approved`, `whatsapp_tpl_rejected`,
`whatsapp_tpl_waitlisted`, `whatsapp_tpl_announcement`,
`whatsapp_tpl_registration_received`).

| Purpose | Default name | Body to submit | Variables |
| --- | --- | --- | --- |
| Approved | `qqsgp_team_approved` | Hello {{1}}! Your team {{2}} has been approved for the QQSGP Free Fire Championship. Registration ID: {{3}}. Watch for match schedules and reporting instructions. — QQSGP Tournament Organizers | name, team, id |
| Waitlisted | `qqsgp_team_waitlisted` | Hello {{1}}! Your team {{2}} has been placed on the waiting list for the QQSGP Free Fire Championship. Registration ID: {{3}}. We will notify you if your registration status changes. — QQSGP Tournament Organizers | name, team, id |
| Rejected | `qqsgp_team_rejected` | Hello {{1}}. The registration status of your team {{2}} for the QQSGP Free Fire Championship has been updated. Registration ID: {{3}}. Please contact the tournament organizers if you need clarification. — QQSGP Tournament Organizers | name, team, id |
| Announcement | `qqsgp_announcement` | Hello {{1}}! An important QQSGP Free Fire Championship announcement for your team {{2}}: {{3}}. Please follow the official tournament instructions. — QQSGP Tournament Organizers | name, team, message |
| Entry received (optional) | `qqsgp_registration_received` | Hello {{1}}! Your team {{2}} is registered for the QQSGP Free Fire Championship. Registration ID: {{3}}. We will message you once the organizers review it. — QQSGP Tournament Organizers | name, team, id |

The variable order in the table is the order the code sends. If you change a
template, change its placeholder count to match — otherwise Meta rejects the
send with `132000`/`132001` and the dashboard will show exactly that reason.

**Do not assume a template is approved** until WhatsApp Manager shows it as
*Approved*. Until then, sends fail and the log records the provider's refusal.

## 5. Webhook (delivery + read receipts)

Without the webhook the log stops at *Accepted by provider* — which is honest,
because Meta has not yet confirmed anything. To receive receipts:

1. Script Properties → `whatsapp_verify_token` = a long random string.
2. Deploy the backend as a **new version** of the existing Web App (so the URL
   stays the same), then use this callback URL in
   **WhatsApp → Configuration → Webhook → Edit**:

   ```
   https://script.google.com/macros/s/<YOUR_DEPLOYMENT_ID>/exec?action=webhook&k=<YOUR_VERIFY_TOKEN>
   ```

3. Verify token: the **same** `whatsapp_verify_token` value.
4. Subscribe to the **messages** field (this is where `sent`/`delivered`/`read`/
   `failed` arrive).

**One honest limitation.** Apps Script does not expose request headers, so the
`X-Hub-Signature-256` header Meta sends **cannot** be validated here. The `k`
token in the URL is what authenticates the call instead, and the endpoint can
only change the delivery state of a notification that already exists — it can
never read registrations, send messages or change a team's status. Treat the URL
(and therefore the verify token) as a secret, and rotate it if it leaks.

## 6. Testing mode without approved templates

While you are still waiting for template approval, set
`whatsapp_mode` = `text` to send free-form text instead. Meta only allows that
inside an open 24-hour service window started by the recipient, so it is for
your own test number, not for teams. **Set it back to `template` (or delete the
property) before the event** — the dashboard shows *text mode (testing only)*
while it is on.

## 7. Consent, privacy and opt-out

- The registration form has an optional, unchecked-by-default WhatsApp box. The
  value is stored as `YES`/`NO` with a timestamp in columns **L** and **M**.
- Only `YES` is ever messaged (`SKIPPED — No WhatsApp consent` otherwise). Older
  rows have no consent column and read as `NO`.
- Numbers are normalised to E.164 (`98765 43210` → `919876543210`); anything
  that is not a valid number is skipped, not guessed at.
- A team is never told another team's number: recipients only ever see their own
  message, and phone numbers are only visible inside the password-protected
  dashboard.
- If a player asks to stop receiving messages, set their team's consent back to
  `NO` in the sheet (or delete the number) — nothing further is sent to them.
- Room IDs and passwords are sensitive: send them with the *Announcement*
  audience set to **Approved teams** or **Selected teams**, never to everyone.

## 8. Reliability rules already built in

- **No status change is lost to WhatsApp.** The sheet write happens first; a
  provider failure is reported on the notification row, never as a failed
  status change.
- **No duplicate message for the same event.** Notification ids are derived from
  the registration id + type + recipient, so a double click, a retry or a
  repeated webhook cannot send the same thing twice.
- **Announcements are idempotent for 10 minutes** (same audience + same text =
  one send). A deliberate reminder later is a different window and goes out.
- **Retries are bounded**: maximum 3 attempts per notification, 60-second
  backoff, and a `SENT`/`DELIVERED`/`READ` row can never be retried.
- **`UNCERTAIN` is never auto-resent**; the dashboard asks for confirmation.
- **Bulk sends are rate-limited** to 25 messages per minute.
- Every announcement is previewed with a recipient count and a confirmation
  prompt before anything leaves the server.

## 9. What was actually tested

`node verify-apps-script.js` — **318 checks, all passing** — runs the real
`apps-script.js` against a mocked Apps Script runtime and a mocked provider.
Covered: phone normalisation; consent gating; the queued → delivered → read
lifecycle; token never leaking into a response or payload; provider rejection;
a lost connection (`UNCERTAIN`) and its protected retry; retry limits; no resend
of an accepted message; the webhook handshake and its refusal of a wrong token;
out-of-order receipts not walking a status backwards; unknown message ids;
announcement audiences excluding rejected teams and non-consented teams;
duplicate-free repeat sends; a new announcement still being delivered; and the
log never carrying the access token.

The dashboard side was exercised in a browser against the same JSON contract:
approve → *Accepted by provider*, no consent → *Skipped*, provider failure →
*Failed* + working Retry, preview → count → confirm → send, and the second
identical announcement producing *already sent* instead of a second blast.

**Not tested, because it needs your account:** a real send to a real number, a
real delivery receipt, and your approved templates. Run `sendTestWhatsApp()`
first, then approve one team and check your own phone.

## 10. Limitations to know

- **Two channels, one team.** The manual approve → WhatsApp step and the Cloud
  API are independent. If you switch the API on later, either skip the manual
  send or turn the approval template off, otherwise a team can receive the same
  message twice.

- No automatic "registration received" message unless `whatsapp_send_receipt` is
  `yes` (and that template is approved).
- Free-form text is not available outside the 24-hour window; everything else
  must be an approved template.
- The webhook cannot verify Meta's signature (see §5) — the URL token is the
  guard.
- Announcements are sent in a loop inside one Apps Script execution; with a few
  hundred teams this is fine, with thousands it would need a queue.
- Delivery states are only as good as Meta's receipts. If the webhook is not
  configured, the log stops at *Accepted by provider* — that is the honest
  answer, not a guess.
- No email fallback and no SMS.
