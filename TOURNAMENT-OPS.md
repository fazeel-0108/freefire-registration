# QQSGP Tournament Operations

This document describes the six-match tournament board added to the organiser
dashboard and the public site. It is written for the organiser who deploys the
Apps Script Web App and maintains the Google Sheet.

## 1. Source of truth

The production workbook remains authoritative. The script only adds three
operational tabs when the dashboard is opened (or when `tournamentSetup()` is
run deliberately):

| Tab | Purpose | Key rule |
| --- | --- | --- |
| `Matches` | One row for each fixed match, M1–M6. | Never create M7. M1–M6 are seeded only when missing. Each row carries a `Stage` and `Room` label. |
| `MatchTeams` | One row per team per match. | A match is one 12-team room. Removing a team sets `State = WITHDRAWN`; the row is not deleted. |
| `Results` | Placement, kills, points and publication state per team per match. | Draft results are private. Only `PUBLISHED` results reach the public board. |

The existing `Registrations`, `Settings`, `Notifications`, `Audit`,
`PaymentDrafts` and organiser stores are unchanged. Historical registrations,
including Goal and shado, are not edited or merged.

### Stable identities

`Registrations.Team ID` (column 27) is the stable 22-character identity used by
`MatchTeams` and `Results`. Team names may be corrected later; the Team ID does
not change. The dashboard backfills missing IDs once, preserving the legacy
deterministic ID.

### Capacity

`Settings` key `max_teams` controls the active-team cap. The shipped default is
**60**. A value of `0` means uncapped. Rejected rows do not consume a slot.
Pending and waitlisted rows do, because they are active registrations awaiting a
decision. The cap is checked under the script lock when a public registration is
written. Once the cap is reached, new public registrations are refused with a
clear "slots are taken" message; the organiser can still manage existing rows.

## 2. Match workflow

1. Open **Matches M1–M6** in the dashboard.
2. Choose a match, map from the list, stage, room label, scheduled date/time and
   status. **Scheduled at** is the match start; **Release at** is when the
   room credentials become public. Both are entered and displayed in
   Asia/Kolkata (IST).
3. Set room ID/password and a **release time**. A room cannot be saved without a
   release time.
4. Save. The public schedule shows the fixture time, map, stage, room label and
   status but withholds room credentials until the release time.
5. Assign approved teams in the assignment bar. Each match holds exactly 12
   slots; choose slot 1–12 or let the board fill the next free slot.
6. Use the **12-slot room chart** to check the slots. **Copy room chart** and
   **Share room chart** use the real team names and slots. **Copy all M1–M6**
   copies all six rooms, and **Share qualified teams** shares the published top
   six. Room credentials are only included after their release time.
7. Use **Copy match schedule** or **Share match schedule** for the full M1–M6
   fixture list. **Share results & leaderboard** shares only published results.
8. Enter placement and kills in **Scoring and results**. The table is ranked by
   the configured tie-breaker order (default: total points, then kills, then
   best placement) and marks the top six as `QUALIFIED` once six results exist.
9. Save as draft, approve, then publish. Drafts never appear publicly.
10. Use **Unpublish** to withdraw a published match result from the public board
   without deleting the result row.

### Suggested stage labels

Use the six fixed rows for six rooms, for example: M1 `QUALIFIER` room A, M2
`QUALIFIER` room B, M3 `KNOCKOUT 1`, M4 `KNOCKOUT 2`, and M5/M6 for the Grand
Final. The stage and room labels are editable, so the exact knockout feed can
follow the registrations rather than being hardcoded. The board shows the top six
from each room, but it does not move teams between rooms automatically; assign
the qualifiers to the next room after checking the chart.

Match statuses: `SCHEDULED`, `LIVE`, `COMPLETED`, `CANCELLED`.
Result statuses: `DRAFT`, `APPROVED`, `PUBLISHED`.

### Room release safety

The public `?action=schedule` endpoint checks `Room Release At` on the server in
Asia/Kolkata time. Before that timestamp it returns `room: null`. The page asks
the server again at the next release instant, so credentials appear without a
manual refresh. The dashboard is the only place that receives the room
ID/password before release. Never put a password in a public announcement or a
screenshot.

Saving a match with a released room queues `room_details` notifications for
assigned, opted-in teams. The `releaseRooms()` trigger also reconciles rooms
whose release time passes while the organiser is offline. Notifications are
deduplicated by event and team, so a refresh or a second trigger run does not
send the same room twice.

## 3. Scoring

Default placement points, applied to 1st through 10th:

```
12, 9, 8, 7, 6, 5, 4, 3, 2, 1
```

Default kill points: `1` per kill. Both are editable in **Scoring settings** and
stored in `Settings`:

- `placement_points` — JSON array, e.g. `[12,9,8,7,6,5,4,3,2,1]`
- `kill_points` — number from 0 to 10
- `tie_breakers` — JSON array containing `total`, `kills` and `placement` in
  the desired order. Use **Scoring settings → Tie-breaker order** to change it.

A result total is:

```
placement_points[placement - 1] + (kills × kill_points)
```

Placements must be whole numbers from 1–12 and unique within a match. Kills must
be whole numbers from 0–100. A team must be actively assigned to the match before
a result can be entered. The top six in a room are marked `QUALIFIED` once results
have been entered.

The leaderboard sums only non-draft results. Public results and the public
leaderboard include only `PUBLISHED` rows, sorted by total points, then kills,
then best placement, then team name.

## 4. WhatsApp events

The existing consent gate applies to every event. Teams without consent are
logged as `SKIPPED`; no provider call is made. Event types added for the board:

| Type | Template suffix | When |
| --- | --- | --- |
| `PAYMENT_RECEIVED` | `payment_received` | Organiser marks a payment `PAID`. |
| `MATCH_SCHEDULED` | `match_scheduled` | Match time/map is saved, or an approved team is assigned to a scheduled match. |
| `MATCH_RESCHEDULED` | `match_rescheduled` | A previously scheduled time changes. |
| `MATCH_REMINDER` | `match_reminder` | Within 60 minutes of the scheduled time; sent by the 15-minute trigger. |
| `ROOM_DETAILS` | `room_details` | Room release time has passed. |
| `RESULTS_PUBLISHED` | `results_published` | Organiser publishes a match result. |

Template names are `<prefix>_<suffix>`, where the prefix defaults to `qqsgp`.
Approve the exact templates with Meta before switching WhatsApp on. Do not
invent template names. See `WHATSAPP.md` for credentials, the webhook and the
retry/delivery rules.

### Triggers

Run `installTournamentTriggers()` once from the Apps Script editor after the
deployment is authorised. It installs:

- `releaseRooms` every 5 minutes
- `sendMatchReminders` every 15 minutes

Both are idempotent. Triggers are not installed automatically, and this project
does not install them on the production account during local development.

## 5. Exports

The dashboard exports:

- registrations (the existing filtered CSV)
- matches
- results
- leaderboard

All four can be downloaded as CSV. The **Export Excel** button requests a real
`.xlsx` workbook assembled server-side with `Utilities.zip`; it contains inline
strings so phone numbers are not silently converted to numbers.

## 6. Deployment and migration (requires owner authorisation)

Nothing below has been run against production.

1. **Back up first.** In Google Sheets choose *File → Make a copy*. Name it with
   the date. Optionally export the current tabs as CSV. Keep the 2 existing teams
   (Goal and shado) and all historical rows exactly as they are.
2. Confirm the production workbook is the one named
   `QQSGP Free Fire Tournament - Production`.
3. In the Apps Script editor, replace the project code with the updated
   `apps-script.js`. Do not edit the sheet by hand.
4. Set the production Script Properties that are intentionally not in the
   repository:
   - `sheet_id` — the production workbook ID (if the deployment needs it)
   - `payment_mode` — `manual` to force organiser-verified UPI/cash, or leave
     unset and no gateway credentials will select manual mode automatically
   - `upi_qr_url` — optional public HTTPS or repository-relative path to the
     official QR image; never put a UPI ID or account number in this property
   - WhatsApp properties from `WHATSAPP.md` only after template approval
5. Deploy a **new version** of the **same** Web App deployment so the URL stays
   unchanged. Do not create a second URL unless you also update both
   `script.js` and `admin.js`.
6. Open the dashboard once, or run `tournamentSetup()` in the editor, to create
   and seed the three new tabs. Verify M1–M6 exist and are empty of teams.
7. Run `whatsappStatus()` (safe, prints no secrets) before enabling notifications.
8. Run `installTournamentTriggers()` only when room release and reminders should
   run automatically.
9. Re-run the local checks in this repository. Do not claim the production
   deployment is verified until a signed-in dashboard session and a public
   schedule/result read have both been checked on the deployed URL.

### Rollback

- Restore the pre-deployment workbook copy if a sheet migration must be undone.
- Deploy the previous Apps Script version from *Manage deployments*.
- New tabs can be left in place; they contain no registration history. Never
  delete or merge registration rows to roll back.

## 7. Security and privacy checklist

- Every dashboard action is authorised on the server by role, not by hiding a
  button.
- Room credentials are returned only to an authenticated organiser before release.
- Public endpoints never return draft results, phone numbers, UPI IDs, merchant
  keys, session tokens or PINs.
- WhatsApp consent is stored with a timestamp and checked for every event.
- A UTR typed by a team is never proof of payment. Only an organiser can move a
  payment to `PAID`.
- Export workbooks contain personal data. Store them privately and delete them
  when no longer needed.
- Keep `upi_qr_url` pointed at an official organiser QR. Do not commit a personal
  QR image or account details to a public repository.

## 8. Known external dependencies

- WhatsApp delivery requires a Meta business account, an approved sender, approved
  templates and the webhook configured exactly as documented.
- Manual UPI verification is a human step; there is no bank API in this project.
- The YouPI gateway code remains dormant for historical review. Manual UPI is the
  active default when no gateway credentials are configured.
- Google Apps Script quotas (execution time, URL fetch, triggers) apply to the
  live deployment.
