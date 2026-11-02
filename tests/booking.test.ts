import { beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "@/lib/db";
import { seed } from "@/lib/db/seed";
import { bookings, mockBusy } from "@/lib/db/schema";
import { createBookingService, BookingError, HOLD_MINUTES, type BookingService } from "@/lib/booking/service";
import { MockCalendarProvider, CalendarUnavailableError, type CalendarProvider } from "@/lib/providers/calendar";
import { MockDripJobsWriter, type DripJobsWriter, type WriteResult } from "@/lib/providers/dripjobs";

// Monday 2026-11-09 05:00 in Phoenix. Seed puts Marco busy Tue 10:00 to 11:30 and Dana on PTO all Tuesday.
const SEED_NOW = new Date("2026-11-09T12:00:00Z");
const PHX = "America/Phoenix";
const TUE = "2026-11-10";
const WED = "2026-11-11";
const phx = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: PHX }).toUTC().toISO()!;

let db: Db;
let clock: Date;
let writer: MockDripJobsWriter;
let calendarOverride: CalendarProvider | null;
let writerOverride: DripJobsWriter | null;
let svc: BookingService;
let keyN = 0;

function customer(extra: Record<string, unknown> = {}) {
  return {
    customerName: "Rosa Delgado",
    customerPhone: "602-555-0147",
    customerEmail: "rosa@example.com",
    address: "1420 E Camelback Rd, Phoenix",
    zip: "85014",
    notes: "Two story exterior",
    agentId: "agent-jordan",
    estimatorId: "est-marco",
    idempotencyKey: `key-${++keyN}-abcdef`,
    ...extra,
  };
}

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BookingError);
  expect((err as BookingError).code).toBe(code);
}

const localStarts = (slots: { start: string }[]) => slots.map((s) => DateTime.fromISO(s.start, { zone: PHX }).toFormat("HH:mm"));
const bookingCount = () => db.select().from(bookings).all().length;

beforeEach(() => {
  db = openDb(":memory:");
  seed(db, SEED_NOW);
  clock = SEED_NOW;
  writer = new MockDripJobsWriter();
  calendarOverride = null;
  writerOverride = null;
  svc = createBookingService({
    db,
    calendarFor: () => calendarOverride ?? new MockCalendarProvider(db),
    writerFor: () => writerOverride ?? writer,
    now: () => clock,
  });
});

describe("availability", () => {
  it("removes busy calendar time plus the client buffer", async () => {
    const r = await svc.availability({ estimatorId: "est-marco", date: TUE });
    expect(localStarts(r.slots)).toEqual(["07:00", "08:00", "12:00", "13:00", "14:00", "15:00"]);
  });
  it("shows a fully blocked day as empty", async () => {
    const r = await svc.availability({ estimatorId: "est-dana", date: TUE });
    expect(r.slots).toEqual([]);
  });
  it("reports why a day is closed", async () => {
    const r = await svc.availability({ estimatorId: "est-marco", date: "2026-11-26" });
    expect(r.closedReason).toBe("blackout_date");
  });
});

describe("no force guarantee", () => {
  it("rejects a forced booking into a busy calendar slot", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "10:00") })), "conflict");
    expect(bookingCount()).toBe(0);
    expect(writer.sent).toHaveLength(0);
  });
  it("rejects a slot that only the buffer blocks", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "09:00") })), "conflict");
  });
  it("rejects a forced booking into an all day event", async () => {
    await rejects(svc.book(customer({ estimatorId: "est-dana", start: phx(TUE, "13:00") })), "conflict");
  });
  it("rejects a time that is not on the slot grid", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "12:15") })), "not_on_grid");
  });
  it("rejects a time outside working hours", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "18:00") })), "outside_hours");
  });
  it("rejects a blackout date", async () => {
    await rejects(svc.book(customer({ start: phx("2026-11-26", "08:00") })), "blackout_date");
  });
  it("rejects a slot inside the notice window", async () => {
    clock = new Date(phx("2026-11-09", "05:30"));
    await rejects(svc.book(customer({ start: phx("2026-11-09", "07:00") })), "too_soon");
  });
  it("rejects a zip the client does not serve", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "12:00"), zip: "10001" })), "zip_not_served");
  });
  it("re-reads the calendar at booking time and catches an event added after the slot was shown", async () => {
    const before = await svc.availability({ estimatorId: "est-marco", date: TUE });
    expect(localStarts(before.slots)).toContain("13:00");
    db.insert(mockBusy).values({ id: "late", estimatorId: "est-marco", title: "Added in Google", start: phx(TUE, "13:00"), end: phx(TUE, "14:00"), allDay: false }).run();
    await rejects(svc.book(customer({ start: phx(TUE, "13:00") })), "conflict");
  });
  it("logs every rejection in the audit log", async () => {
    await rejects(svc.book(customer({ start: phx(TUE, "10:00") })), "conflict");
    expect(svc.recentAudit().some((a) => a.action === "booking_rejected")).toBe(true);
  });
  it("rejects invalid input with a 400", async () => {
    const err = await svc.book({ ...customer(), customerPhone: "x", start: phx(TUE, "12:00") }).catch((e) => e);
    expect(err.code).toBe("invalid_input");
    expect(err.status).toBe(400);
  });
});

describe("booking", () => {
  it("books an open slot and sends it to DripJobs once", async () => {
    const { booking } = await svc.book(customer({ start: phx(TUE, "12:00") }));
    expect(booking.status).toBe("confirmed");
    expect(booking.dripjobsStatus).toBe("sent");
    expect(writer.sent).toHaveLength(1);
    expect(writer.sent[0]).toMatchObject({ estimator_name: "Marco Ruiz", customer_first_name: "Rosa", start_local: "2026-11-10T12:00:00.000-07:00", duration_minutes: 60 });
  });
  it("removes the booked slot and its buffer from availability", async () => {
    await svc.book(customer({ start: phx(TUE, "13:00") }));
    const r = await svc.availability({ estimatorId: "est-marco", date: TUE });
    expect(localStarts(r.slots)).toEqual(["07:00", "08:00", "15:00"]);
  });
  it("refuses a second booking for the same slot", async () => {
    await svc.book(customer({ start: phx(TUE, "12:00") }));
    await rejects(svc.book(customer({ agentId: "agent-sam", start: phx(TUE, "12:00") })), "conflict");
    expect(bookingCount()).toBe(1);
  });
  it("lets exactly one of two simultaneous requests win", async () => {
    const results = await Promise.allSettled([
      svc.book(customer({ agentId: "agent-jordan", start: phx(TUE, "14:00") })),
      svc.book(customer({ agentId: "agent-sam", start: phx(TUE, "14:00") })),
      svc.book(customer({ agentId: "agent-avery", start: phx(TUE, "14:00") })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(bookingCount()).toBe(1);
  });
  it("returns the original booking when the same idempotency key is retried", async () => {
    const req = customer({ start: phx(TUE, "12:00") });
    const a = await svc.book(req);
    const b = await svc.book(req);
    expect(b.duplicate).toBe(true);
    expect(b.booking.id).toBe(a.booking.id);
    expect(writer.sent).toHaveLength(1);
  });
  it("enforces the daily cap", async () => {
    for (const t of ["07:00", "09:00", "11:00", "15:00"]) await svc.book(customer({ start: phx(WED, t) }));
    await rejects(svc.book(customer({ start: phx(WED, "08:00") })), "daily_cap_reached");
  });
  it("frees the slot when a booking is cancelled", async () => {
    const { booking } = await svc.book(customer({ start: phx(TUE, "12:00") }));
    svc.cancel(booking.id, "admin");
    const again = await svc.book(customer({ agentId: "agent-sam", start: phx(TUE, "12:00") }));
    expect(again.booking.status).toBe("confirmed");
  });
});

describe("holds", () => {
  it("a hold blocks the slot for other agents", async () => {
    await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "12:00") });
    const forSam = await svc.availability({ estimatorId: "est-marco", date: TUE, agentId: "agent-sam" });
    expect(localStarts(forSam.slots)).not.toContain("12:00");
    await rejects(svc.placeHold({ estimatorId: "est-marco", agentId: "agent-sam", start: phx(TUE, "12:00") }), "conflict");
    await rejects(svc.book(customer({ agentId: "agent-sam", start: phx(TUE, "12:00") })), "conflict");
  });
  it("the holding agent still sees and can book the slot", async () => {
    const hold = await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "12:00") });
    const mine = await svc.availability({ estimatorId: "est-marco", date: TUE, agentId: "agent-jordan" });
    expect(mine.myHold?.id).toBe(hold.id);
    const { booking } = await svc.book(customer({ start: phx(TUE, "12:00"), holdId: hold.id }));
    expect(booking.status).toBe("confirmed");
  });
  it("a hold expires", async () => {
    await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "12:00") });
    clock = new Date(SEED_NOW.getTime() + (HOLD_MINUTES + 1) * 60_000);
    const hold = await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-sam", start: phx(TUE, "12:00") });
    expect(hold.agentId).toBe("agent-sam");
  });
  it("placing a new hold releases the agent's previous hold", async () => {
    await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "12:00") });
    await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "15:00") });
    const hold = await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-sam", start: phx(TUE, "12:00") });
    expect(hold.agentId).toBe("agent-sam");
  });
  it("a rejected hold is logged and still releases the agent's old hold", async () => {
    await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "12:00") });
    await rejects(svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "10:00") }), "conflict");
    expect(svc.recentAudit().some((a) => a.action === "hold_rejected")).toBe(true);
    const hold = await svc.placeHold({ estimatorId: "est-marco", agentId: "agent-sam", start: phx(TUE, "12:00") });
    expect(hold.agentId).toBe("agent-sam");
  });
  it("cannot hold a busy slot", async () => {
    await rejects(svc.placeHold({ estimatorId: "est-marco", agentId: "agent-jordan", start: phx(TUE, "10:00") }), "conflict");
  });
});

describe("failures", () => {
  it("fails closed when the calendar cannot be read", async () => {
    calendarOverride = { name: "broken", getBusy: async () => { throw new CalendarUnavailableError("Google down"); } };
    await rejects(svc.availability({ estimatorId: "est-marco", date: TUE }), "calendar_unavailable");
    await rejects(svc.book(customer({ start: phx(TUE, "12:00") })), "calendar_unavailable");
    expect(bookingCount()).toBe(0);
  });
  it("keeps the booking and flags it when DripJobs fails, then retry succeeds", async () => {
    writerOverride = { name: "flaky", send: async (): Promise<WriteResult> => ({ ok: false, detail: "HTTP 502", retryable: true }) };
    const { booking } = await svc.book(customer({ start: phx(TUE, "12:00") }));
    expect(booking.dripjobsStatus).toBe("failed");
    expect(db.select().from(bookings).where(eq(bookings.id, booking.id)).get()?.status).toBe("confirmed");
    writerOverride = null;
    const retried = await svc.sendToDripJobs(booking.id);
    expect(retried.dripjobsStatus).toBe("sent");
  });
  it("a writer that throws is recorded as failed, not lost", async () => {
    writerOverride = { name: "boom", send: async () => { throw new Error("socket hang up"); } };
    const { booking } = await svc.book(customer({ start: phx(TUE, "12:00") }));
    expect(booking.dripjobsStatus).toBe("failed");
    expect(booking.dripjobsDetail).toContain("socket hang up");
  });
});
