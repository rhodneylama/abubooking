# Scheduling engine, porting guide

This guide is for a developer or AI agent bringing the ABU scheduling engine into another app.

## What to copy

| File | What it is | Needed |
|---|---|---|
| `src/lib/availability/engine.ts` | The engine. A pure TypeScript module with no I/O. Its only dependency is `luxon`. | Yes |
| `tests/engine.test.ts` | 39 tests covering hours, buffers, notice, caps, blackouts, zips, all day events, timezones and DST. | Yes, port them alongside |
| `src/lib/booking/service.ts` | A reference for wiring the engine into a booking flow so nobody can force a slot (holds, transaction, idempotency, fail closed). Uses Drizzle and SQLite. | Read it as a pattern, then adapt |
| `tests/booking.test.ts` | Tests for the no-force guarantee: forced slots rejected, races, holds, retries. | Useful as a spec |

Run them with `npm install && npx vitest run`. All 81 tests pass.

## Engine API

```ts
computeAvailability({ rules, date, busy, bookings, now, zip? })
  // -> { date, timezone, slots: {start: Date, end: Date}[], closedReason? }

checkSlot({ rules, busy, bookings, now, zip? }, start: Date)
  // -> { ok: true, slot, date } | { ok: false, reason }

isZipServed(rules, zip)
REJECTION_MESSAGES[reason]   // human readable text for each rejection code
```

`rules` (`ClientRules`, one set per client):
- `timezone`: an IANA name such as `America/Phoenix`. Every time of day is read in this zone.
- `workDays`: ISO weekdays, 1 = Monday through 7 = Sunday.
- `dayStart` / `dayEnd`: `"HH:mm"`. The last slot must end by `dayEnd`.
- `slotMinutes`: appointment length. `stepMinutes`: spacing between slot starts, defaulting to `slotMinutes`.
- `bufferMinutes`: gap required on both sides of any busy block or booking.
- `minNoticeMinutes`: lead time from `now`.
- `maxPerDay`: cap on bookings per estimator per local day. 0 means no cap.
- `blackoutDates`: `"YYYY-MM-DD"` local dates.
- `allowedZips`: 5 digit zips. An empty list means every zip is served.

Inputs:
- `busy`: calendar busy blocks plus other agents' live holds. Mark all day events with `allDay: true` and they block the whole local day.
- `bookings`: confirmed bookings already saved for this estimator. These count toward `maxPerDay`.
- `date`: a local `"YYYY-MM-DD"` in the client's timezone.

Rejection codes: `not_a_work_day`, `blackout_date`, `daily_cap_reached`, `zip_not_served`, `invalid_date`, `not_on_grid`, `outside_hours`, `too_soon`, `conflict`.

## Integration rules (these are what prevent double bookings)

1. **Show slots** with `computeAvailability`, passing a fresh calendar read for the local day plus one day either side. The extra days are for buffers and multi day events.
2. **Never trust the client's chosen time.** At hold time and again at booking time:
   1. Re-read the calendar.
   2. Inside one database transaction, load the saved bookings and other agents' unexpired holds, call `checkSlot`, and insert the booking only if it returns `ok`.
3. **Fail closed.** If the calendar read fails, offer and accept nothing. Never treat an error as an empty calendar.
4. **Add a database backstop.** Put a unique index on `(estimator_id, start)` for confirmed bookings and a unique `idempotency_key`, so retries and races cannot create duplicates.
5. **Push to DripJobs or Zapier only after saving.** If the push fails, keep the booking, flag it, and allow a retry.
6. **Write rejection audit entries after the rollback, not inside the failed transaction.** Inside, they are rolled back and lost.

## Known gap

Google freeBusy does not mark which blocks are all day events. If another source supplies all day events as UTC midnight dates, convert them to local midnight in the client's timezone before passing them in. Otherwise they can also block the day before.
