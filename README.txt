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
verify-apps-script.js Test harness for apps-script.js (node only)

DOCS
----
ADMIN.md              Dashboard deployment, authentication, security checklist
WHATSAPP.md           WhatsApp Cloud API setup, templates, webhook, limits

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
12. Upload index.html, style.css, script.js, logo.png and favicon.png
    to GitHub Pages, Netlify, Vercel, or your preferred hosting.
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
protected by a dashboard key that lives in Script Properties: run setupAdminKey()
once in the editor and paste the value it prints into the page. See ADMIN.md.

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

EMAIL
-----
If ORGANIZER_EMAIL is filled in apps-script.js, you also receive an email
whenever a team registers.

NOTE
----
"Java" is not required for this website. The browser-side language is
JavaScript. Google Apps Script is also JavaScript-based, so you can build
this project without running a Java server.
