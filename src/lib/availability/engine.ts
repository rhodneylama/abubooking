import { DateTime, Interval } from "luxon";

/**
 * Scheduling rules for one client. Every time of day is interpreted in the
 * client's own IANA timezone, so a 9am start means 9am where the estimator works.
 */
export interface ClientRules {
  timezone: string;
  /** ISO weekdays that take appointments. 1 = Monday, 7 = Sunday. */
  workDays: number[];
  /** "HH:mm" local start of the bookable day. */
  dayStart: string;
  /** "HH:mm" local end of the bookable day. The last slot must end by this time. */
  dayEnd: string;
  /** Length of one estimate appointment in minutes. */
  slotMinutes: number;
  /** Distance between slot start times in minutes. Defaults to slotMinutes. */
  stepMinutes?: number;
  /** Required gap before and after any busy block, in minutes. */
  bufferMinutes: number;
  /** Minimum lead time between now and the start of a slot, in minutes. */
  minNoticeMinutes: number;
  /** Maximum confirmed bookings per estimator per local day. 0 means no cap. */
  maxPerDay: number;
  /** Local dates ("YYYY-MM-DD") with no appointments at all. */
  blackoutDates: string[];
  /** Zip codes this client serves. An empty list means every zip is served. */
  allowedZips: string[];
}

export interface BusyBlock {
  start: Date;
  end: Date;
  /** All day events block the whole local day regardless of their stored times. */
  allDay?: boolean;
}

export interface Slot {
  start: Date;
  end: Date;
}

export type ClosedReason =
  | "not_a_work_day"
  | "blackout_date"
  | "daily_cap_reached"
  | "zip_not_served"
  | "invalid_date";

export type SlotRejection =
  | ClosedReason
  | "not_on_grid"
  | "outside_hours"
  | "too_soon"
  | "conflict";

export interface AvailabilityInput {
  rules: ClientRules;
  /** Local date "YYYY-MM-DD" in the client's timezone. */
  date: string;
  /** Busy blocks from the calendar plus holds owned by other agents. */
  busy: BusyBlock[];
  /** Confirmed bookings for this estimator that are already saved locally. */
  bookings: Slot[];
  now: Date;
  /** Customer zip. When given, it must be in allowedZips (if the list is non empty). */
  zip?: string;
}

export interface AvailabilityResult {
  date: string;
  timezone: string;
  slots: Slot[];
  /** Set when the whole day is closed. */
  closedReason?: ClosedReason;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLocalTime(date: string, hhmm: string, zone: string): DateTime {
  return DateTime.fromISO(`${date}T${hhmm}`, { zone });
}

export function normalizeZip(zip: string): string {
  return zip.trim().slice(0, 5);
}

export function isZipServed(rules: ClientRules, zip: string | undefined): boolean {
  if (rules.allowedZips.length === 0) return true;
  if (!zip) return false;
  return rules.allowedZips.includes(normalizeZip(zip));
}

/** Expand a busy block into the interval it actually occupies, honoring all day events. */
function blockInterval(block: BusyBlock, zone: string): Interval {
  if (block.allDay) {
    const startDay = DateTime.fromJSDate(block.start, { zone }).startOf("day");
    // An all day event that ends exactly at midnight does not cover the following day.
    let endDay = DateTime.fromJSDate(block.end, { zone });
    endDay = endDay.equals(endDay.startOf("day")) ? endDay : endDay.endOf("day").plus({ milliseconds: 1 });
    if (endDay <= startDay) endDay = startDay.plus({ days: 1 });
    return Interval.fromDateTimes(startDay, endDay);
  }
  return Interval.fromDateTimes(
    DateTime.fromJSDate(block.start, { zone }),
    DateTime.fromJSDate(block.end, { zone }),
  );
}

function dayClosedReason(input: AvailabilityInput): ClosedReason | undefined {
  const { rules, date } = input;
  if (!DATE_RE.test(date)) return "invalid_date";
  const day = DateTime.fromISO(date, { zone: rules.timezone });
  if (!day.isValid) return "invalid_date";
  if (input.zip !== undefined && !isZipServed(rules, input.zip)) return "zip_not_served";
  if (rules.blackoutDates.includes(date)) return "blackout_date";
  if (!rules.workDays.includes(day.weekday)) return "not_a_work_day";
  if (rules.maxPerDay > 0) {
    const count = input.bookings.filter(
      (b) => DateTime.fromJSDate(b.start, { zone: rules.timezone }).toISODate() === date,
    ).length;
    if (count >= rules.maxPerDay) return "daily_cap_reached";
  }
  return undefined;
}

/** Every slot on the grid for the day, before conflicts and notice are applied. */
function gridSlots(rules: ClientRules, date: string): Interval[] {
  const zone = rules.timezone;
  const open = parseLocalTime(date, rules.dayStart, zone);
  const close = parseLocalTime(date, rules.dayEnd, zone);
  const step = rules.stepMinutes && rules.stepMinutes > 0 ? rules.stepMinutes : rules.slotMinutes;
  const out: Interval[] = [];
  if (!open.isValid || !close.isValid || rules.slotMinutes <= 0) return out;
  // Walk in absolute minutes so a DST change inside the window cannot create or drop a slot.
  for (let cursor = open; ; cursor = cursor.plus({ minutes: step })) {
    const end = cursor.plus({ minutes: rules.slotMinutes });
    if (end > close) break;
    out.push(Interval.fromDateTimes(cursor, end));
  }
  return out;
}

function slotRejection(slot: Interval, input: AvailabilityInput): SlotRejection | undefined {
  const zone = input.rules.timezone;
  const earliest = DateTime.fromJSDate(input.now, { zone }).plus({ minutes: input.rules.minNoticeMinutes });
  if (slot.start! < earliest) return "too_soon";
  const buffer = input.rules.bufferMinutes;
  const padded = Interval.fromDateTimes(
    slot.start!.minus({ minutes: buffer }),
    slot.end!.plus({ minutes: buffer }),
  );
  for (const b of input.busy) {
    const iv = blockInterval(b, zone);
    // All day events block the day itself, not the buffer zone around it.
    const test = b.allDay ? slot : padded;
    if (iv.isValid && test.overlaps(iv)) return "conflict";
  }
  for (const b of input.bookings) {
    const iv = Interval.fromDateTimes(DateTime.fromJSDate(b.start, { zone }), DateTime.fromJSDate(b.end, { zone }));
    if (iv.isValid && padded.overlaps(iv)) return "conflict";
  }
  return undefined;
}

function toSlot(iv: Interval): Slot {
  return { start: iv.start!.toJSDate(), end: iv.end!.toJSDate() };
}

/** Compute the open slots for one estimator on one local date. Pure, no I/O. */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const base = { date: input.date, timezone: input.rules.timezone };
  const closed = dayClosedReason(input);
  if (closed) return { ...base, slots: [], closedReason: closed };
  const slots = gridSlots(input.rules, input.date)
    .filter((iv) => slotRejection(iv, input) === undefined)
    .map(toSlot);
  return { ...base, slots };
}

/**
 * Decide whether a specific requested start time is bookable. This is the check
 * the server runs on every hold and every booking, so the client UI cannot force
 * a slot that the rules or the calendar say is taken.
 */
export function checkSlot(
  input: Omit<AvailabilityInput, "date">,
  start: Date,
): { ok: true; slot: Slot; date: string } | { ok: false; reason: SlotRejection } {
  const zone = input.rules.timezone;
  const startDt = DateTime.fromJSDate(start, { zone });
  if (!startDt.isValid) return { ok: false, reason: "invalid_date" };
  const date = startDt.toISODate()!;
  const full: AvailabilityInput = { ...input, date };
  const closed = dayClosedReason(full);
  if (closed) return { ok: false, reason: closed };
  const grid = gridSlots(input.rules, date);
  const match = grid.find((iv) => iv.start!.toMillis() === startDt.toMillis());
  if (!match) {
    const open = parseLocalTime(date, input.rules.dayStart, zone);
    const close = parseLocalTime(date, input.rules.dayEnd, zone);
    const inside = startDt >= open && startDt.plus({ minutes: input.rules.slotMinutes }) <= close;
    return { ok: false, reason: inside ? "not_on_grid" : "outside_hours" };
  }
  const rejection = slotRejection(match, full);
  if (rejection) return { ok: false, reason: rejection };
  return { ok: true, slot: toSlot(match), date };
}

export const REJECTION_MESSAGES: Record<SlotRejection, string> = {
  not_a_work_day: "This estimator does not take appointments on that day",
  blackout_date: "That date is blacked out for this client",
  daily_cap_reached: "This estimator is fully booked for that day",
  zip_not_served: "This client does not serve that zip code",
  invalid_date: "That date is not valid",
  not_on_grid: "That time is not one of the offered slots",
  outside_hours: "That time is outside working hours",
  too_soon: "That slot is too soon to book",
  conflict: "That slot is no longer open",
};
