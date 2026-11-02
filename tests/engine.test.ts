import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { computeAvailability, checkSlot, isZipServed, type ClientRules, type BusyBlock } from "@/lib/availability/engine";

const phoenix: ClientRules = {
  timezone: "America/Phoenix",
  workDays: [1, 2, 3, 4, 5],
  dayStart: "08:00",
  dayEnd: "12:00",
  slotMinutes: 60,
  bufferMinutes: 0,
  minNoticeMinutes: 0,
  maxPerDay: 0,
  blackoutDates: [],
  allowedZips: [],
};

const ny: ClientRules = { ...phoenix, timezone: "America/New_York", dayStart: "09:00", dayEnd: "17:00", slotMinutes: 90 };

// Monday 2026-11-09. Phoenix is UTC-7 all year.
const MON = "2026-11-09";
const longAgo = new Date("2020-01-01T00:00:00Z");

function at(date: string, hhmm: string, zone: string): Date {
  return DateTime.fromISO(`${date}T${hhmm}`, { zone }).toJSDate();
}
function local(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat("HH:mm");
}
function run(rules: ClientRules, opts: Partial<{ date: string; busy: BusyBlock[]; bookings: { start: Date; end: Date }[]; now: Date; zip: string }> = {}) {
  return computeAvailability({ rules, date: opts.date ?? MON, busy: opts.busy ?? [], bookings: opts.bookings ?? [], now: opts.now ?? longAgo, zip: opts.zip });
}
const starts = (r: ReturnType<typeof run>, zone = phoenix.timezone) => r.slots.map((s) => local(s.start, zone));

describe("grid", () => {
  it("returns hourly slots inside working hours", () => {
    expect(starts(run(phoenix))).toEqual(["08:00", "09:00", "10:00", "11:00"]);
  });
  it("drops a final slot that would run past day end", () => {
    expect(starts(run({ ...phoenix, dayEnd: "11:30" }))).toEqual(["08:00", "09:00", "10:00"]);
  });
  it("supports a step shorter than the slot length", () => {
    expect(starts(run({ ...phoenix, stepMinutes: 30 }))).toEqual(["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]);
  });
  it("slot end equals start plus slot length", () => {
    const s = run(phoenix).slots[0];
    expect(s.end.getTime() - s.start.getTime()).toBe(60 * 60 * 1000);
  });
  it("returns no slots when day end is before day start", () => {
    expect(run({ ...phoenix, dayStart: "12:00", dayEnd: "08:00" }).slots).toEqual([]);
  });
});

describe("day level rules", () => {
  it("closes weekends that are not work days", () => {
    const r = run(phoenix, { date: "2026-11-08" });
    expect(r.slots).toEqual([]);
    expect(r.closedReason).toBe("not_a_work_day");
  });
  it("opens Saturday when it is in workDays", () => {
    expect(run({ ...phoenix, workDays: [6] }, { date: "2026-11-07" }).slots.length).toBe(4);
  });
  it("closes blackout dates", () => {
    expect(run({ ...phoenix, blackoutDates: [MON] }).closedReason).toBe("blackout_date");
  });
  it("closes the day when the daily cap is reached", () => {
    const bookings = [{ start: at(MON, "08:00", phoenix.timezone), end: at(MON, "09:00", phoenix.timezone) }];
    expect(run({ ...phoenix, maxPerDay: 1 }, { bookings }).closedReason).toBe("daily_cap_reached");
  });
  it("only counts bookings on the same local date toward the cap", () => {
    const bookings = [{ start: at("2026-11-10", "08:00", phoenix.timezone), end: at("2026-11-10", "09:00", phoenix.timezone) }];
    expect(run({ ...phoenix, maxPerDay: 1 }, { bookings }).slots.length).toBe(4);
  });
  it("rejects invalid dates", () => {
    expect(run(phoenix, { date: "2026-13-45" }).closedReason).toBe("invalid_date");
    expect(run(phoenix, { date: "next tuesday" }).closedReason).toBe("invalid_date");
  });
});

describe("zip codes", () => {
  const rules = { ...phoenix, allowedZips: ["85001", "85004"] };
  it("serves listed zips", () => expect(isZipServed(rules, "85004")).toBe(true));
  it("normalizes zip plus four", () => expect(isZipServed(rules, "85004-1234")).toBe(true));
  it("refuses unlisted zips", () => expect(run(rules, { zip: "90210" }).closedReason).toBe("zip_not_served"));
  it("serves every zip when the list is empty", () => expect(isZipServed(phoenix, "90210")).toBe(true));
});

describe("busy blocks and buffers", () => {
  const tz = phoenix.timezone;
  it("removes a slot that overlaps a busy block", () => {
    const busy = [{ start: at(MON, "09:15", tz), end: at(MON, "09:45", tz) }];
    expect(starts(run(phoenix, { busy }))).toEqual(["08:00", "10:00", "11:00"]);
  });
  it("treats touching blocks as no conflict without a buffer", () => {
    const busy = [{ start: at(MON, "09:00", tz), end: at(MON, "10:00", tz) }];
    expect(starts(run(phoenix, { busy }))).toEqual(["08:00", "10:00", "11:00"]);
  });
  it("applies the buffer on both sides of a busy block", () => {
    const busy = [{ start: at(MON, "09:00", tz), end: at(MON, "10:00", tz) }];
    expect(starts(run({ ...phoenix, bufferMinutes: 15 }, { busy }))).toEqual(["11:00"]);
  });
  it("applies the buffer around saved bookings too", () => {
    const bookings = [{ start: at(MON, "10:00", tz), end: at(MON, "11:00", tz) }];
    expect(starts(run({ ...phoenix, bufferMinutes: 30 }, { bookings }))).toEqual(["08:00"]);
  });
  it("an all day event blocks the whole day", () => {
    const busy = [{ start: at(MON, "00:00", tz), end: at("2026-11-10", "00:00", tz), allDay: true }];
    expect(run(phoenix, { busy }).slots).toEqual([]);
  });
  it("an all day event does not spill into the next day", () => {
    const busy = [{ start: at(MON, "00:00", tz), end: at("2026-11-10", "00:00", tz), allDay: true }];
    expect(run(phoenix, { date: "2026-11-10", busy }).slots.length).toBe(4);
  });
  it("an all day event stored as a UTC date still blocks the local day", () => {
    // Google returns all day events as dates. Stored as UTC midnight they would start at 5pm the prior day in Phoenix.
    const busy = [{ start: new Date(`${MON}T00:00:00Z`), end: new Date("2026-11-10T00:00:00Z"), allDay: true }];
    const r = run(phoenix, { busy });
    expect(r.slots).toEqual([]);
  });
  it("a multi day event blocks every day it covers", () => {
    const busy = [{ start: at(MON, "15:00", tz), end: at("2026-11-11", "09:30", tz) }];
    expect(run(phoenix, { date: "2026-11-10", busy }).slots).toEqual([]);
    expect(starts(run(phoenix, { date: "2026-11-11", busy }))).toEqual(["10:00", "11:00"]);
  });
});

describe("notice", () => {
  const tz = phoenix.timezone;
  it("hides slots inside the minimum notice window", () => {
    const now = at(MON, "07:30", tz);
    expect(starts(run({ ...phoenix, minNoticeMinutes: 120 }, { now }))).toEqual(["10:00", "11:00"]);
  });
  it("hides slots that already started", () => {
    expect(starts(run(phoenix, { now: at(MON, "09:01", tz) }))).toEqual(["10:00", "11:00"]);
  });
  it("notice can push past the end of the day", () => {
    expect(run({ ...phoenix, minNoticeMinutes: 24 * 60 }, { now: at(MON, "07:00", tz) }).slots).toEqual([]);
  });
});

describe("timezones and DST", () => {
  it("returns UTC instants that match the client's local clock", () => {
    const r = run(phoenix);
    expect(r.slots[0].start.toISOString()).toBe("2026-11-09T15:00:00.000Z");
  });
  it("same rules produce different UTC instants for different zones", () => {
    const a = run({ ...phoenix, timezone: "America/New_York" }).slots[0].start.toISOString();
    expect(a).toBe("2026-11-09T13:00:00.000Z");
  });
  it("handles the day after the fall back change in New York", () => {
    // DST ended 2026-11-01. Monday 2026-11-02 is EST, UTC-5.
    const r = run(ny, { date: "2026-11-02" });
    expect(r.slots[0].start.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(starts(r, ny.timezone)).toEqual(["09:00", "10:30", "12:00", "13:30", "15:00"]);
  });
  it("handles a spring forward Sunday with early hours", () => {
    // 2027-03-14 02:00 does not exist in New York. A 01:00 to 05:00 window loses an hour.
    const rules = { ...ny, workDays: [7], dayStart: "01:00", dayEnd: "05:00", slotMinutes: 60 };
    const r = run(rules, { date: "2027-03-14" });
    expect(starts(r, ny.timezone)).toEqual(["01:00", "03:00", "04:00"]);
  });
  it("handles a fall back Sunday with early hours without duplicate local slots", () => {
    const rules = { ...ny, workDays: [7], dayStart: "00:00", dayEnd: "03:00", slotMinutes: 60 };
    const r = run(rules, { date: "2026-11-01" });
    // Four real hours exist between local midnight and 03:00 on this day.
    expect(r.slots.length).toBe(4);
    const iso = r.slots.map((s) => s.start.toISOString());
    expect(new Set(iso).size).toBe(iso.length);
  });
  it("Phoenix ignores DST", () => {
    const summer = run(phoenix, { date: "2026-07-06" }).slots[0].start.toISOString();
    expect(summer).toBe("2026-07-06T15:00:00.000Z");
  });
});

describe("checkSlot", () => {
  const tz = phoenix.timezone;
  const base = { rules: phoenix, busy: [], bookings: [], now: longAgo };
  it("accepts an open slot", () => {
    const r = checkSlot(base, at(MON, "09:00", tz));
    expect(r.ok).toBe(true);
  });
  it("rejects a time that is not on the grid", () => {
    expect(checkSlot(base, at(MON, "09:10", tz))).toEqual({ ok: false, reason: "not_on_grid" });
  });
  it("rejects a time outside working hours", () => {
    expect(checkSlot(base, at(MON, "18:00", tz))).toEqual({ ok: false, reason: "outside_hours" });
  });
  it("rejects a conflicting slot", () => {
    const busy = [{ start: at(MON, "09:00", tz), end: at(MON, "09:30", tz) }];
    expect(checkSlot({ ...base, busy }, at(MON, "09:00", tz))).toEqual({ ok: false, reason: "conflict" });
  });
  it("rejects a slot on a closed day", () => {
    expect(checkSlot(base, at("2026-11-08", "09:00", tz))).toEqual({ ok: false, reason: "not_a_work_day" });
  });
  it("rejects a slot inside the notice window", () => {
    const r = checkSlot({ ...base, rules: { ...phoenix, minNoticeMinutes: 60 }, now: at(MON, "08:30", tz) }, at(MON, "09:00", tz));
    expect(r).toEqual({ ok: false, reason: "too_soon" });
  });
  it("rejects an unserved zip", () => {
    const r = checkSlot({ ...base, rules: { ...phoenix, allowedZips: ["85001"] }, zip: "10001" }, at(MON, "09:00", tz));
    expect(r).toEqual({ ok: false, reason: "zip_not_served" });
  });
});
