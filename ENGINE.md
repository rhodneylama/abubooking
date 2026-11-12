# Scheduling engine porting guide

This guide is for a developer or AI agent bringing the ABU scheduling engine into another app, most likely the Docket platform expansion (see the Docket section below).

## What to copy

| File | What it is | Needed |
|---|---|---|
| `src/lib/availability/engine.ts` | The engine. One pure TypeScript module with no I/O. Its only dependency is `luxon` | Yes |
| `tests/engine.test.ts` | 39 tests covering hours, buffers, notice, caps, blackouts, zips, all day events, timezones and DST | Yes, port them alongside |
| `src/lib/booking/service.ts` | Reference for wiring the engine into a booking flow so nobody can force a slot (holds, transaction, idempotency, fail closed). Uses Drizzle and SQLite | Read as a pattern, then adapt |
| `tests/booking.test.ts` | Tests for the no force guarantee, covering forced slots, races, holds and retries | Useful as a spec |

Run them with `npm install && npx vitest run`. All 81 tests pass.

## Engine API

```ts
computeAvailability({ rules, date, busy, bookings, now, zip? })
  // returns { date, timezone, slots, closedReason? }

checkSlot({ rules, busy, bookings, now, zip? }, start)
  // returns { ok: true, slot, date } or { ok: false, reason }

isZipServed(rules, zip)
REJECTION_MESSAGES[reason]   // plain text for each rejection code
```

`rules` is a `ClientRules` object, one per client.

| Field | Meaning |
|---|---|
| `timezone` | IANA name such as `America/Phoenix`. Every time of day is read in this zone |
| `workDays` | ISO weekdays, 1 is Monday and 7 is Sunday |
| `dayStart`, `dayEnd` | `"HH:mm"`. The last slot must end by `dayEnd` |
| `slotMinutes` | Appointment length |
| `stepMinutes` | Spacing between slot starts. Defaults to `slotMinutes` |
| `bufferMinutes` | Gap required on both sides of any busy block or booking |
| `minNoticeMinutes` | Lead time from `now` |
| `maxPerDay` | Cap on bookings per estimator per local day. 0 means no cap |
| `blackoutDates` | Local dates as `"YYYY-MM-DD"` |
| `allowedZips` | 5 digit zips. An empty list means every zip is served |

The other inputs are as follows.

| Input | Meaning |
|---|---|
| `busy` | Calendar busy blocks plus other agents' live holds. Mark all day events with `allDay: true` and they block the whole local day |
| `bookings` | Confirmed bookings already saved for this estimator. These count toward `maxPerDay` |
| `date` | A local `"YYYY-MM-DD"` in the client's timezone |

The rejection codes are `not_a_work_day`, `blackout_date`, `daily_cap_reached`, `zip_not_served`, `invalid_date`, `not_on_grid`, `outside_hours`, `too_soon` and `conflict`.

## Integration rules that prevent double bookings

1. **Show slots** with `computeAvailability`, passing a fresh calendar read for the local day plus one day either side. The extra days cover buffers and multi day events.
2. **Never trust the chosen time from the browser.** At hold time and again at booking time, re-read the calendar. Then, inside one database transaction, load saved bookings and other agents' unexpired holds, call `checkSlot`, and insert the booking only if it returns `ok`.
3. **Fail closed.** If the calendar read fails, offer and accept nothing. Never treat an error as an empty calendar.
4. **Add a database backstop.** Put a unique index on `(estimator_id, start)` for confirmed bookings and a unique `idempotency_key`, so retries and races cannot create duplicates.
5. **Push to DripJobs or Zapier only after saving.** If the push fails, keep the booking, flag it, and allow a retry.
6. **Write rejection audit entries after the rollback, not inside the failed transaction.** Inside, they are rolled back and lost.

## Fitting the engine into Docket

The Docket platform spec names this booking widget work as the base for the Drip Jobs sync. These notes map the engine onto that spec.

**Where it plugs in**
- Phase 2 outbound, where leads agents book from the lead queue and the booking goes into the client's CRM (M2)
- M5, where agents book directly in Docket while on a call
- M13 in Phase 8, the direct CRM push to Drip Jobs and other client systems
- AI QA of bookings against the info sheet (M2). Store the rejection codes and the info sheet version used on each booking so QA can check them

**Ground rules from the spec**
- Port into the docket-platform copy only. Never touch the original Docket beta.
- Rules should be built from the client's current info sheet version (M6), not stored as a separate copy. Record the info sheet version on each booking.
- When a client record has no time zone, use `America/New_York`. ABU's 8 AM to 10 PM Eastern business day is when agents work. It is not the client's booking window, so do not feed it into `dayStart` and `dayEnd`.
- Store everything as structured data, as the spec requires.

**How info sheet fields map to the engine**

| Info sheet field | Engine field |
|---|---|
| Hours and client time zone | `timezone`, `dayStart`, `dayEnd`, `workDays` |
| Weekend rules | `workDays` |
| Capacity | `maxPerDay` |
| Booking windows | `dayStart`, `dayEnd`, `slotMinutes`, `stepMinutes` |
| Same day rules | `minNoticeMinutes`, partly (see gaps) |
| Service area | `allowedZips` for now. Replace with the M6 service area checker |

**Gaps to build in Docket**
1. **No same day flag.** `minNoticeMinutes` cannot say "earliest is tomorrow." Add a `noSameDay` boolean, or compute notice to the next local midnight.
2. **One window per day.** The spec allows per weekday hours and several booking windows a day. Change `dayStart` and `dayEnd` to a list of windows per weekday.
3. **Service area is zip only.** The M6 checker adds cities, the anywhere except mode, stretch distance and postal codes outside the US. Run that checker first and drop `allowedZips` from the engine, or have `isZipServed` call it.
4. **One estimator at a time.** Some clients book a company calendar rather than a person. Loop over estimators, or treat the client as a single calendar.
5. **All day events from other sources.** Google freeBusy does not mark all day events. If another source sends them as UTC midnight dates, convert them to local midnight in the client's time zone first. Otherwise they also block the day before.
