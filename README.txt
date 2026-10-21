FREE FIRE TOURNAMENT REGISTRATION
Quli Qutub Shah Government Polytechnic

FILES
-----
index.html            Main registration page
style.css             Premium UI
script.js             Form validation + submission + live counter
rules.html            Tournament rules (+ rules.css, rules.js)
admin.html            Organiser dashboard (+ admin.css, admin.js)
apps-script.js        Google Sheets backend + admin API + WhatsApp API
logo.png              College emblem (transparent background)
favicon.png           Browser tab icon
upi-qr.png            Original FamApp UPI QR (Rs 100 team fee). Local only.
upi-pay-qr.png        Scannable copy of the UPI QR: same UPI ID, dark on white,
                      Rs 100 already filled in. Local only, never deployed.
verify-apps-script.js Test harness for apps-script.js (node only)
verify-approve.js     Tests for the dashboard approve -> WhatsApp message

DOCS
----
ADMIN.md              Dashboard deployment, security checklist
ORGANISERS.md         Organiser accounts, PIN sign-in, roles, sessions, limits
WHATSAPP.md           WhatsApp Cloud API setup, templates, webhook, limits
PAYMENTS.md           Verified online payment, Razorpay setup, YouPI evaluation

HOW TO CONNECT IT
-----------------
1. Create a Google Sheet in your Google account.
2. Open Extensions > Apps Script.
3. Paste the complete contents of apps-script.js.
4. Optional: put your email inside ORGANIZER_EMAIL.
5. Optional: set MAX_TEAMS to limit team slots (0 = no limit).
6. Click Deploy > New deployment.
7. Select "Web app".
8. Execute as: Me.
9. Who has access: Anyone.
10. Deploy and copy the Web App URL.
11. Open script.js and replace:
       PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE
    with your Web App URL.
12. Upload index.html, style.css, script.js, logo.png and favicon.png to
    GitHub Pages, Netlify, Vercel, or your preferred hosting. The payment
    screen is drawn by the gateway, so no QR image is needed.
13. Test by submitting one fake team.
14. Open the Google Sheet. Every team will appear as one organized row.
15. Reload the Google Sheet. A "Tournament" menu appears with
    "Apply sheet formatting" and "Show registration stats".

UPDATING THE BACKEND LATER
--------------------------
When you change apps-script.js you must publish it, or the website keeps
using the old code:
  Deploy > Manage deployments > pencil icon on the active deployment >
  Version: New version > Deploy.
Use "New version" on the SAME deployment so the Web App URL in script.js
stays valid.

LIVE COUNTER
------------
The page shows Teams / Players / Departments counters. They read from the
Apps Script Web App URL:
    <WEB_APP_URL>?action=stats
If the counters show dashes (—), the deployed backend is an older version
that has no stats endpoint. Publish a new version (see above) and reload.
The counters are cached for 20 seconds to keep the sheet fast. Set
MAX_TEAMS in apps-script.js to also show "N slots left".

SHEET LAYOUT
------------
The script formats the sheet automatically: dark branded header, frozen
header row and first two columns, column widths, a department dropdown,
green/white row stripes and light row separators. A player whose WhatsApp
number appears in two different teams is highlighted in red.

ORGANISER DASHBOARD
-------------------
admin.html reads and changes the same sheet through POST ?action=admin. It is
protected by organiser accounts (Organiser ID + PIN, verified on the server,
with roles and expiring sessions). The old shared dashboard key still works as
a Super Admin recovery path only. See ORGANISERS.md and ADMIN.md.

WHATSAPP
--------
Optional. Approving, rejecting or waitlisting a team can send the leader an
official WhatsApp Cloud API message, and the dashboard can send announcements.
It is off until the Script Properties in WHATSAPP.md are filled in; nothing is
ever sent without the team's consent. Accepted by the provider is NOT the same
as delivered - delivery and read states only appear once the webhook is set up.

IMPORTANT
---------
Do not put Google account passwords, API keys, or private credentials in
HTML/CSS/JavaScript. The Google Apps Script Web App is the backend; WhatsApp
tokens live in Script Properties, never in the repository.

PAYMENT (FEE FROM SETTINGS, VERIFIED ONLINE)
---------------------------------------------
The fee lives in the Settings tab (entry_fee) and is edited in the dashboard's
"Tournament settings" panel. Every new registration copies the fee of that
moment onto its row, so changing the price later never rewrites an old team.
Nothing in the site or the backend hardcodes the amount.

  ONLINE  The page opens a payment session for exactly the live fee and shows
          the gateway's own interface: a single-use UPI QR (Razorpay) or the
          YouPI checkout page (self-hosted). The backend asks the gateway, with
          the merchant secret, whether that session was paid; only a confirmed
          payment in INR for the exact fee snapshot writes the row. It is
          stored as ONLINE / PAID with the order id, payment id, amount,
          currency, verification time and provider.
          There is no "I have paid" button and a typed UTR is not accepted.
  CASH    The row is saved as CASH / PENDING and the team pays at the ground.
          You change it to PAID once the money is in your hand.

Which gateway is used is one Script Property (payment_provider: youpi, the
default, or razorpay as a fallback). Online payment is off until that provider's
credentials exist; the page then says so and Cash still works.

With YouPI, a payment the gateway reports at a verification level below the
configured minimum (default 2: bank SMS + Gmail) is NOT registered. It waits in
the dashboard's "Payments to review" section, where an organiser accepts it
with a note or rejects it. Razorpay's captured UPI payments need no such step.

Setup for both, the security model, the exact tests and a straight assessment
of YouPI PG are in PAYMENTS.md.

upi-qr.png is the owner's original FamApp image, copied byte for byte. It is
kept as the payment record, not shown on the page: FamApp draws it light-on-dark
with the logo over the data, and an ordinary scanner reads nothing from it.

upi-pay-qr.png is its scannable copy, drawn dark-on-light from the same UPI ID
(decoded out of upi-qr.png, so nothing was retyped), with the amount inside.
Neither image is used by the live payment flow: the site never shows a bare
personal QR, because a personal UPI QR has no API to confirm that money
arrived. Both are local print assets for a poster or a manual collection desk,
and neither is published with the website.

WHAT YOU RECEIVE
----------------
Each submission creates one row containing:
- Timestamp
- Team name
- Department
- Player 1 / Leader name
- Player 1 / Leader WhatsApp
- Player 2 name + WhatsApp
- Player 3 name + WhatsApp
- Player 4 name + WhatsApp
- Entry fee, payment method, payment status, UPI reference,
  payment note, payment updated at / by
- Approval status and its own updated at / by

EMAIL
-----
If ORGANIZER_EMAIL is filled in apps-script.js, you also receive an email
whenever a team registers.

NOTE
----
"Java" is not required for this website. The browser-side language is
JavaScript. Google Apps Script is also JavaScript-based, so you can build
this project without running a Java server.
