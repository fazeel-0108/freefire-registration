# QQSGP Tournament Operations

This document describes the room-based tournament board used by the organiser
dashboard and the public site. It is written for the organiser who deploys the
Apps Script Web App and maintains the Google Sheet. Nothing here has been run
against production: deployment steps are at the end and need owner approval.

## 1. Source of truth

The production workbook remains authoritative. There is one workbook, one
`Registrations` tab and one tournament board; the script never creates a
spreadsheet per room, match or stage.

| Tab | Purpose | Key rule |
| --- | --- | --- |
| `Registrations` | Every squad, its players, status, note, consent and payment columns. | Never edited or merged by the tournament code. `Team ID` (column 27) is the stable identity. |
| `Matches` | One row for each match, M1–M6. | Seeded once when missing. Holds stage, map, schedule, status and a copy of Room A's credentials for legacy readers. M7 must never exist. |
| `TournamentRooms` | One row per **match + room**: `Match ID, Room, Room ID, Room Password, Release At, Notes, Updated At, Updated By`. | Room A and Room B each own their credentials and their release instant. A room id/password cannot be saved without a release time. |
| `MatchTeams` | One row per team per match, now with a `Room` column. | A team holds one active seat per match. Removing a team sets `State = WITHDRAWN`; the row is never deleted. A blank room on an old row reads as Room A. |
| `Results` | Placement, kills, points, status per team per match, now with a `Room` column. | Room A and Room B are saved, verified and published separately. Draft rows are private. |
| `Evidence` | Referee photo link per match and room: file id, URL, name, MIME type, size, uploader, timestamp, stage. | Optional. Never required to save a result. |
| `Settings` | Fee, `max_teams`, `match_count`, `stage_match_counts`, scoring and tie-breakers. | One place for the tournament's configuration. |
| `Audit` | Who changed what, including result corrections with the previous value. | Append-only. |

Registration history, payment history and the organiser accounts are untouched
by the tournament code. The dashboard backfills missing `Team ID`s once, using
the deterministic legacy ID so an existing row keeps its identity.

### Capacity

`Settings` key `max_teams` controls the active-team cap (default 60, `0` means
uncapped). Rejected rows do not consume a slot; pending and waitlisted rows do.
The cap is checked under the script lock when a public registration is written.
A separate hard limit applies inside a room: **12 seats**, enforced on the server.

## 2. Rooms first

A match is played in **Room A** and **Room B** at the same time. Each room has:

- its own Room ID and password (never shown in the other room),
- its own release time (India time, Asia/Kolkata),
- its own twelve slots,
- its own result table, result status, evidence photo and leaderboard.

The dashboard opens **Rooms and slot assignments** with two room panels side by
side. Each panel has the credential form, the 12-slot roster and its own
*Copy slot list* / *Share* button.

1. Choose **Number of matches** (1–6) and save. Only those match numbers are
   generated anywhere — the dropdowns, the tables, the schedule and the boards.
   The same control exists per stage, so a knockout stage can play two matches
   while the final plays one.
2. Fill the schedule form: match, stage, map, **Scheduled at** (IST), status
   (`DRAFT`, `SCHEDULED`, `LIVE`, `COMPLETED`, `CANCELLED`) and notes. Save.
3. In each room panel, enter Room ID, password and **Release at**, then save that
   room. Room A and Room B are saved by their own button; saving one never
   writes the other. Rescheduling a match never wipes either credential.
4. Add teams in **Slot assignment**: match → room → team → slot (leave the slot
   empty for the next free one) → *Save assignment*. The table below lists every
   seat as `Match | Room | Slot | Team`.
5. Use the **Slot list** panel for the WhatsApp poster of one room, or *Copy
   every room* for all of them.

### Slot rules (checked on the server, not only in the browser)

- One team, one seat per match. A second attempt is refused with
  `This team is already assigned to ROOM B — Slot 7.`
- Two teams cannot share a slot in the same match and room. The same slot number
  in the other room is free.
- A room refuses a thirteenth team. The other room still accepts it.
- Only an `APPROVED` registration can be seated; an unknown or unapproved team is
  refused.
- Removing a seat is a confirmation step. A published result is kept for the
  record even when the seat is withdrawn.
- A qualified team can always be seated in a later match (a new M number); it
  keeps its original `Team ID` and name and receives a new room and slot.

### Room credential release

The public `?action=schedule` endpoint answers **per room**: before that room's
release instant it returns an empty Room ID and password for it, and only that
room is affected. Marking a match `SCHEDULED` never releases credentials; only
the release time does. The dashboard is the only place that sees credentials
before release. Never put a password in a public announcement or a screenshot.

Saving a released room queues `ROOM_DETAILS` notifications for assigned,
consented teams. `releaseRooms()` reconciles rooms whose release time passes
while the organiser is offline. Notifications are deduplicated per match, room
and team, so a refresh or a second trigger run sends nothing twice.

## 3. Slot lists

The poster and the copy/share text are generated from saved assignments, never
from typed samples:

```
🏆 QQSGP FREE FIRE TOURNAMENT

MATCH: M2
ROOM: ROOM B
MAP: Bermuda

SLOT 1 — Team Name
...
SLOT 12 — Team Name

SCHEDULED AT: 05 Dec 2026, 08:00 PM IST
```

A room with fewer than twelve teams prints `OPEN SLOT` for the empty seats and a
line such as `9 of 12 slots filled — 3 still open`. Room ID and password lines
are added only after that room's release time.

## 4. Results, room by room

1. In **Results and leaderboards** choose stage → match → room. The table loads
   exactly that room's seated teams, by slot, with any saved values.
2. Enter **Placement** (1–12, unique inside the room) and **Kills** (0–100).
   Placement points, kill points, total and the room rank are calculated as you
   type.
3. **Save Room results** writes the whole room in one call. The backend validates
   the seat, the room, duplicate teams, duplicate placements and the ranges.
4. `Mark submitted` → `Verify` → `Publish room` moves that room's rows along
   `DRAFT` → `APPROVED` → `VERIFIED` → `PUBLISHED`. A room cannot be published
   while any of its rows is still a draft. `Unpublish room` withdraws it without
   deleting the data.
5. Attach an optional **Referee photo**: PNG, JPEG or WebP up to 1.5 MB, stored
   in the Drive folder `QQSGP Referee Evidence`, linked to the match, room, stage,
   uploader and time. The link is visible to signed-in organisers.
6. A verified or published row cannot be overwritten silently: the save is
   refused with a correction warning, and a confirmed correction is written to
   `Audit` with the previous placement, kills, points and status.

### Scoring

```
placement_points[placement - 1] + (kills × kill_points)
```

Defaults: `12, 9, 8, 7, 6, 5, 4, 3, 2, 1` for 1st–10th and `1` per kill, both
editable in **Scoring settings** (`placement_points`, `kill_points`). Tie-breakers
are configurable (`tie_breakers`, default `total,kills,placement`), and the
order changes both the room boards and the combined boards.

## 5. The three leaderboards

| Board | What it contains | Where it appears |
| --- | --- | --- |
| **Room leaderboard** | Only the teams seated in that room, ranked `#1…#12`. | Room panel and below the result grid. |
| **Match leaderboard** | Every verified team of that match across **all rooms**, ranked on actual points and tie-breakers. Room A's rank 1 is never assumed to be better than Room B's rank 1. | Results section and the public board. |
| **Stage leaderboard** | One column per configured match, cumulative points, total kills and overall rank for every team with results in that stage. Marked **Provisional** until every configured match of the stage is verified, then **Final**. | Results section, copy/share buttons, public board. |

A team with no result in a match shows `—` in that column: no invented points,
no invented match count. Stage boards are kept per stage; points from different
stages are never mixed unless the organiser adds a tournament-wide ranking.

Qualification follows the stage's own board. A qualified team keeps its
`Team ID` when it is seated in the next stage.

## 6. WhatsApp events

The existing consent gate applies to every event. Teams without consent are
logged as `SKIPPED`; no provider call is made.

| Type | Template suffix | When |
| --- | --- | --- |
| `PAYMENT_RECEIVED` | `payment_received` | Organiser marks a payment `PAID` (manual UPI or cash). |
| `MATCH_SCHEDULED` | `match_scheduled` | Match time/map is saved, or an approved team is seated in a scheduled match. |
| `MATCH_RESCHEDULED` | `match_rescheduled` | A previously scheduled time changes. |
| `MATCH_REMINDER` | `match_reminder` | Within 60 minutes of the scheduled time; sent by the 15-minute trigger. |
| `ROOM_DETAILS` | `room_details` | That room's release time has passed. |
| `RESULTS_PUBLISHED` | `results_published` | A room's results are published. |

Template names are `<prefix>_<suffix>`, default prefix `qqsgp`. Approve the exact
templates with Meta before switching WhatsApp on; do not invent template names.
See `WHATSAPP.md` for credentials, webhook, retry and delivery rules.

### Triggers

`installTournamentTriggers()` installs `releaseRooms` (every 5 minutes) and
`sendMatchReminders` (every 15 minutes). Both are idempotent and are not
installed automatically.

## 7. Payments (manual only)

The approved workflow is **manual**: UPI QR or cash, verified by an organiser.
`payment_mode = manual` (or no gateway credentials configured) keeps the site in
that mode. A visitor may claim a payment and give a UTR, but only an organiser can
move a row to `PAID`, and the row records who did it and when. **Do not enable the
YouPI gateway or any automatic verification without owner approval.** The dormant
gateway code and its Script Properties are kept for historical review and no
property value is printed anywhere.

## 8. Exports

The dashboard exports registrations (filtered CSV), matches, results and the
leaderboard as CSV, plus one `.xlsx` workbook built server-side with inline
strings so phone numbers are not converted to numbers.

## 9. Deployment and migration (requires owner authorisation)

Nothing below has been run against production.

1. **Back up first.** In Google Sheets choose *File → Make a copy*, named with
   the date. Keep every existing registration, payment and result row.
2. In the Apps Script editor, replace the project code with the updated
   `apps-script.js`. Do not hand-edit the sheet.
3. Set only the Script Properties that the deployment needs (`sheet_id`,
   optional `upi_qr_url`, WhatsApp properties after template approval). Gateway
   properties stay as they are; they are not part of the manual workflow.
4. Deploy a **new version** of the **same** Web App deployment so the URL stays
   unchanged. Do not create a second URL unless `script.js` and `admin.js` are
   updated too.
5. Open the dashboard once to run `ensureTournamentSheets_()`. It creates
   `TournamentRooms` and `Evidence`, adds the `Room` columns to `MatchTeams` and
   `Results` (append-only), removes the obsolete stored `match_ids` property and
   seeds M1–M6. Existing rows are not rewritten.
6. Enter both rooms' credentials and release times, then seat teams.
7. Run `whatsappStatus()` (prints no secrets) before enabling notifications, and
   `installTournamentTriggers()` only when release and reminders should run.
8. Verify on the deployed URL with a signed-in dashboard session: two rooms in
   one match, credentials hidden before release and visible after, a room result
   saved and verified, the combined match board and the stage board, and the
   public schedule/result pages.

### Rollback

- Restore the pre-deployment workbook copy if a migration must be undone.
- Deploy the previous Apps Script version from *Manage deployments*.
- New tabs and columns may be left in place; they hold no registration history.
  Never delete or merge registration rows to roll back.

## 10. Security and privacy checklist

- Every dashboard action is authorised on the server by role, not by hiding a
  button.
- Room credentials reach an authenticated organiser only, and each room's values
  are returned only for that room.
- Public endpoints never return draft results, phone numbers, UPI details,
  merchant keys, session tokens or PINs.
- WhatsApp consent is stored with a timestamp and checked for every event.
- A UTR typed by a team is never proof of payment.
- Export workbooks contain personal data: store them privately.
- Keep `upi_qr_url` pointed at an official organiser QR; never commit a personal
  QR image or account details to a public repository.

## 11. Known external dependencies

- WhatsApp delivery requires a Meta business account, an approved sender,
  approved templates and the configured webhook.
- Manual UPI verification is a human step; there is no bank API in this project.
- Google Apps Script quotas (execution time, URL fetch, triggers, Drive) apply to
  the live deployment.
