# Staging setup — QQSGP × YouPI PG

This folder prepares a **second, isolated copy** of the backend. It never
touches the production Sheet, the production Apps Script project, its Script
Properties or the live website.

Files:

| File | Purpose |
| --- | --- |
| `appsscript.json` | Manifest for the staging deployment (V8, Asia/Kolkata, web app = Me / Anyone). |
| `prepare-staging.js` | Copies `../apps-script.js` into `staging/build/Code.js` and writes a no-secret checklist. Refuses the production project id. |
| `check-staging.js` | Read-only check of a staging `/exec` URL (`config` and `stats` only). Refuses the production deployment. |
| `console.html` | Premium staging control room served at `/__test/staging/console.html` by the local preview server. |
| `console.js`, `console.css` | Its live checks, synthetic flow and styling. |
| `.staging.json.example` | Copy to `.staging.json` (gitignored) after deploying staging; fill `execUrl` with the staging `/exec` URL. |
| `build/` | Generated. Ignored by git; contains `Code.js`, `appsscript.json`, a staging-only `StagingCheck.gs`, the checklist and an optional `.clasp.json`. |

Nothing here contains a Sheet ID, merchant key or admin key.

---

## 1. Create the staging Sheet

1. Open the **production** Sheet from your own bookmark. Do not rename or move it.
2. **File → Make a copy**. Name the copy:

   `QQSGP STAGING — do not take payments`

3. In the **copy**, delete every real team row, keeping the header row. If the
   copy has no `Settings`, `PaymentDrafts`, `Audit` or `Notifications` tab yet,
   that is fine — the script creates them on first use.
4. Note the copy's ID from its URL, privately:

   `https://docs.google.com/spreadsheets/d/`**`<STAGING_SHEET_ID>`**`/edit`

   Never paste that ID into chat, a tracked file or a screenshot.

Both Sheets now exist. The staging one is a copy; the production one is
unchanged.

## 2. Create the staging Apps Script project

1. With the **staging copy** open: **Extensions → Apps Script**.
   This makes a script **bound to the copy** with its own project ID.
2. Rename the project to `QQSGP STAGING` (top-left title).
3. Build the code to paste:

   ```bash
   node staging/prepare-staging.js
   ```

   Paste the whole of `staging/build/Code.js` into the editor's `Code.gs`,
   replacing the default `myFunction`. Add one more file,
   `StagingCheck.gs`, with the contents of `staging/build/StagingCheck.gs`.
4. Open **Project Settings → Show `appsscript.json` manifest file**, then
   replace its contents with `staging/appsscript.json`.
5. In **Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `sheet_id` | the **staging** Sheet ID from step 1 |

   `sheet_id` is required: a deployed web app has no active spreadsheet, so the
   script must be told which book to open. Do **not** copy production
   properties such as `admin_key`, `org_accounts_v1` or `org_sessions_v1`.

   Do **not** add `youpi_base_url`, `youpi_merchant_id` or
   `youpi_merchant_key` yet. Online payment must stay off until the YouPI
   instance, merchant and public HTTPS URL exist.

6. In the editor, run `stagingTarget()` once. It prints the target Sheet's
   **name** and row count, never its ID. It must say `"verdict":"STAGING"` and
   `"registrationRows":0`; anything else means `sheet_id` points at the wrong
   book — stop and fix the property.
7. Optional: run `setupAdminKey()` once from the editor if you want a bypass
   dashboard key for staging. Do not reuse the production key.

## 3. Open the staging control room

With the preview server running (`node .preview-server.js . 8788`):

```
http://127.0.0.1:8788/__test/staging/console.html
```

It reads production with public GETs only, shows the real test results, and
tests the registration flow against the in-memory mock. It does not create a
Sheet or a deployment.

## 4. Deploy the staging web app

1. **Deploy → New deployment → Web app**.
2. Description: `staging`.
3. **Execute as:** `Me`.
4. **Who has access:** `Anyone` (the public page must reach it).
5. Deploy, authorise the script, and copy the `/exec` URL.
6. Check it before using it:

   ```bash
   node staging/check-staging.js "https://script.google.com/macros/s/<staging-id>/exec"
   ```

   Expected: reachable, `provider: YOUPI`, `online:false`, and an empty staging
   Sheet. The script refuses the production URL and only performs GETs.
7. For the console, copy `staging/.staging.json.example` to
   `staging/.staging.json` and put the same `/exec` URL in `execUrl`. The file
   is gitignored. Do not put a merchant key or Sheet ID in it.

## 5. Point a copy of the page at staging (optional)

1. Copy `index.html`, `script.js`, `admin.html` and `admin.js` to a scratch
   folder outside the repo.
2. In the copies only, change `APPS_SCRIPT_URL` to the staging `/exec` URL in
   both `script.js` and `admin.js`.
3. Serve the folder over HTTPS or `http://localhost`. Do not publish it.
4. Register one synthetic **cash** team and confirm exactly one new row appears
   in the **staging** Sheet, not production.

## 5a. What was actually provisioned on 2026-11-03

`clasp` was already authorised as the organiser's Google account, so the
staging resources were created without touching production:

- **Sheet:** `QQSGP STAGING - do not take payments` (new, empty). No production
  row, tab or property was copied into it.
- **Script:** a separate Apps Script project bound to that Sheet. The clean
  `Code.js` (byte-identical to `apps-script.js`), `StagingCheck.gs` and
  `staging/appsscript.json` were pushed to it.
- **Deployment:** a staging `/exec` deployment exists and is recorded in the
  gitignored `staging/.staging.json`, so this control room can check it.

It is **not usable yet**. The `/exec` endpoint answers `HTTP 403` because the
script has not been authorised by its owner, and `sheet_id` has not been set.
Google does not allow `clasp` to accept the Spreadsheet consent prompt or to
write Script Properties. That is the one remaining manual Google step:

1. Open the staging Sheet named above from Google Drive.
2. **Extensions → Apps Script**; run `stagingTarget()` once and approve the
   requested Sheets scopes.
3. **Project Settings → Script Properties** → set `sheet_id` to that staging
   Sheet's ID (visible in its URL; never paste it into chat or a tracked file).
4. **Deploy → Manage deployments → edit** the existing web app, deploy a new
   version with **Execute as Me / Anyone**, and refresh this control room.

The recording in `staging/.staging.json` is local and gitignored. If the
staging project is ever recreated, update that file with the new `/exec` URL.

## 6. Verify the production `sheet_id` without revealing it

1. Open the production Sheet. Its URL contains `/d/<PRODUCTION_SHEET_ID>/edit`.
2. Open the production Apps Script project → **Project Settings → Script
   Properties** → the `sheet_id` row.
3. Compare the two privately, character by character. Do not copy either into
   chat, a file, an issue or a screenshot.
4. Cross-check behaviour: `?action=stats` must show the same team count and last
   entry as the visible rows, and `?action=config`'s `fee` must equal
   `Settings → entry_fee` in that Sheet.
5. If they disagree, **stop**. Do not change the property; one of the two is the
   wrong Sheet, and changing it could move live registrations.

## 7. Which deployment is which

| Deployment | Where it appears | What it is |
| --- | --- | --- |
| `AKfycbw_-E7L9…` | `script.js` line 6 and `admin.js` line 18 | **Current.** Both the site and dashboard use it. Its `?action=config` returns `provider`, `hosted`, `label`, `minVerification`. |
| `AKfycbxqAaa…` | Only in git history: it was removed by commit `b91d788` ("Point the site at the sheet the event actually uses now") | **Obsolete.** Still reachable, but its `?action=config` is the old pre-payment shape (`service`, `status`, `endpoints`) and it reads a different, older Sheet. |

Do not edit `.clasp-push/` for staging: its `.clasp.json` names the production
script and its `Code.js` is older than `apps-script.js`. A `clasp push` from
there would overwrite the live backend. The generated `staging/build/` is the
only folder intended for a staging push.

## 8. Why mock payments cannot mark production PAID

- The mock harness binds to `127.0.0.1` and has no outbound HTTP client. Its
  "gateway" is a local page; `/__mock/pay` updates an in-memory draft only.
- The real `apps-script.js` refuses a client-supplied `ONLINE`/`PAID` value and
  writes `PAID` only after its own authenticated status read.
- `node verify-preview-isolation.js` asserts both points and runs a complete
  mock payment, so a broken harness fails the check instead of silently
  reaching the live deployment.
