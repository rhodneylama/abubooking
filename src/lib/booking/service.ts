import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, lte, ne } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { checkSlot, computeAvailability, isZipServed, REJECTION_MESSAGES, type BusyBlock, type ClientRules, type Slot, type SlotRejection } from "@/lib/availability/engine";
import type { Db } from "@/lib/db";
import { agents, auditLog, bookings, clients, estimators, holds, type Booking, type Client, type Estimator } from "@/lib/db/schema";
import { CalendarUnavailableError, type CalendarProvider } from "@/lib/providers/calendar";
import { buildPayload, type DripJobsWriter } from "@/lib/providers/dripjobs";

export const HOLD_MINUTES = 5;

export class BookingError extends Error {
  constructor(public code: SlotRejection | "not_found" | "invalid_input" | "calendar_unavailable" | "hold_expired", message: string, public status = 409) {
    super(message);
    this.name = "BookingError";
  }
}

export const customerSchema = z.object({
  customerName: z.string().trim().min(2, "Enter the customer's full name").max(120),
  customerPhone: z.string().trim().regex(/^[\d\s()+.-]{7,20}$/, "Enter a valid phone number"),
  customerEmail: z.union([z.literal(""), z.string().trim().email("Enter a valid email")]).optional(),
  address: z.string().trim().min(5, "Enter the street address").max(200),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5 digit zip code"),
  notes: z.string().trim().max(1000).optional(),
});

export const bookingRequestSchema = customerSchema.extend({
  estimatorId: z.string().min(1),
  agentId: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  holdId: z.string().optional(),
  idempotencyKey: z.string().min(8).max(100),
});

export type BookingRequest = z.infer<typeof bookingRequestSchema>;

export interface ServiceDeps {
  db: Db;
  calendarFor: (estimator: Estimator) => CalendarProvider;
  writerFor: (client: Client) => DripJobsWriter;
  now?: () => Date;
}

export function rulesOf(c: Client): ClientRules {
  return {
    timezone: c.timezone,
    workDays: c.workDays,
    dayStart: c.dayStart,
    dayEnd: c.dayEnd,
    slotMinutes: c.slotMinutes,
    stepMinutes: c.stepMinutes ?? undefined,
    bufferMinutes: c.bufferMinutes,
    minNoticeMinutes: c.minNoticeMinutes,
    maxPerDay: c.maxPerDay,
    blackoutDates: c.blackoutDates,
    allowedZips: c.allowedZips,
  };
}

export function createBookingService(deps: ServiceDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function audit(actor: string, action: string, detail: Record<string, unknown>) {
    db.insert(auditLog).values({ at: now().toISOString(), actor, action, detail }).run();
  }

  function load(estimatorId: string) {
    const estimator = db.select().from(estimators).where(eq(estimators.id, estimatorId)).get();
    if (!estimator || !estimator.active) throw new BookingError("not_found", "Estimator not found", 404);
    const client = db.select().from(clients).where(eq(clients.id, estimator.clientId)).get();
    if (!client || !client.active) throw new BookingError("not_found", "Client not found", 404);
    return { estimator, client };
  }

  /** Window that covers the local day plus a day either side, enough for buffers and all day events. */
  function windowFor(client: Client, date: string) {
    const day = DateTime.fromISO(date, { zone: client.timezone }).startOf("day");
    return { from: day.minus({ days: 1 }).toJSDate(), to: day.plus({ days: 2 }).toJSDate() };
  }

  async function readCalendar(estimator: Estimator, client: Client, date: string): Promise<BusyBlock[]> {
    const { from, to } = windowFor(client, date);
    try {
      return await deps.calendarFor(estimator).getBusy(estimator, from, to);
    } catch (err) {
      // Fail closed. If we cannot see the calendar we do not offer or accept any slot.
      const msg = err instanceof Error ? err.message : String(err);
      audit("system", "calendar_error", { estimatorId: estimator.id, date, error: msg });
      throw new BookingError("calendar_unavailable", err instanceof CalendarUnavailableError ? `Calendar unavailable. ${msg}` : "Calendar unavailable, try again", 503);
    }
  }

  /** Local state that blocks slots: confirmed bookings and other agents' live holds. Read inside the caller's transaction. */
  function localBlocks(tx: Db, estimatorId: string, client: Client, date: string, agentId?: string) {
    const { from, to } = windowFor(client, date);
    const nowIso = now().toISOString();
    const booked: Slot[] = tx
      .select({ start: bookings.start, end: bookings.end })
      .from(bookings)
      .where(and(eq(bookings.estimatorId, estimatorId), eq(bookings.status, "confirmed"), lt(bookings.start, to.toISOString()), gt(bookings.end, from.toISOString())))
      .all()
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    const heldConds = [eq(holds.estimatorId, estimatorId), gt(holds.expiresAt, nowIso)];
    if (agentId) heldConds.push(ne(holds.agentId, agentId));
    const held: BusyBlock[] = tx
      .select({ start: holds.start, end: holds.end })
      .from(holds)
      .where(and(...heldConds))
      .all()
      .map((h) => ({ start: new Date(h.start), end: new Date(h.end) }));
    return { booked, held };
  }

  function rejection(reason: SlotRejection): BookingError {
    return new BookingError(reason, REJECTION_MESSAGES[reason], reason === "invalid_date" ? 400 : 409);
  }

  /** Push a saved booking to DripJobs. Safe to call again for a failed send. */
  async function sendToDripJobs(bookingId: string, agentName?: string): Promise<Booking> {
    const booking = db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
    if (!booking) throw new BookingError("not_found", "Booking not found", 404);
    const { estimator, client } = load(booking.estimatorId);
    const name = agentName ?? db.select().from(agents).where(eq(agents.id, booking.agentId)).get()?.name ?? booking.agentId;
    const writer = deps.writerFor(client);
    let result;
    try {
      result = await writer.send(buildPayload(booking, client, estimator, name), client);
    } catch (err) {
      result = { ok: false as const, detail: err instanceof Error ? err.message : String(err), retryable: true };
    }
    const status = result.ok ? "sent" : "failed";
    const detail = `${writer.name}. ${result.detail}`;
    db.update(bookings).set({ dripjobsStatus: status, dripjobsDetail: detail }).where(eq(bookings.id, booking.id)).run();
    audit("system", result.ok ? "dripjobs_sent" : "dripjobs_failed", { bookingId: booking.id, writer: writer.name, detail: result.detail });
    return { ...booking, dripjobsStatus: status, dripjobsDetail: detail };
  }

  return {
    listDirectory() {
      const cs = db.select().from(clients).where(eq(clients.active, true)).orderBy(asc(clients.name)).all();
      const es = db.select().from(estimators).where(eq(estimators.active, true)).orderBy(asc(estimators.name)).all();
      const as = db.select().from(agents).orderBy(asc(agents.name)).all();
      return {
        clients: cs.map((c) => ({ id: c.id, name: c.name, timezone: c.timezone, slotMinutes: c.slotMinutes, estimators: es.filter((e) => e.clientId === c.id).map((e) => ({ id: e.id, name: e.name })) })),
        agents: as,
      };
    },

    async availability(params: { estimatorId: string; date: string; agentId?: string; zip?: string }) {
      const { estimator, client } = load(params.estimatorId);
      const busy = await readCalendar(estimator, client, params.date);
      const { booked, held } = localBlocks(db, estimator.id, client, params.date, params.agentId);
      const result = computeAvailability({ rules: rulesOf(client), date: params.date, busy: [...busy, ...held], bookings: booked, now: now(), zip: params.zip || undefined });
      const mine = params.agentId
        ? db.select().from(holds).where(and(eq(holds.estimatorId, estimator.id), eq(holds.agentId, params.agentId), gt(holds.expiresAt, now().toISOString()))).get()
        : undefined;
      return {
        ...result,
        closedMessage: result.closedReason ? REJECTION_MESSAGES[result.closedReason] : undefined,
        slots: result.slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
        myHold: mine ? { id: mine.id, start: mine.start, expiresAt: mine.expiresAt } : null,
        calendarSource: deps.calendarFor(estimator).name,
      };
    },

    async placeHold(params: { estimatorId: string; agentId: string; start: string }) {
      const { estimator, client } = load(params.estimatorId);
      const agent = db.select().from(agents).where(eq(agents.id, params.agentId)).get();
      if (!agent) throw new BookingError("not_found", "Agent not found", 404);
      const start = new Date(params.start);
      if (Number.isNaN(start.getTime())) throw rejection("invalid_date");
      const date = DateTime.fromJSDate(start, { zone: client.timezone }).toISODate()!;
      const busy = await readCalendar(estimator, client, date);
      const outcome = db.transaction((tx) => {
        const nowIso = now().toISOString();
        tx.delete(holds).where(lte(holds.expiresAt, nowIso)).run();
        // One live hold per agent. Picking a new slot releases the old one.
        tx.delete(holds).where(eq(holds.agentId, agent.id)).run();
        const { booked, held } = localBlocks(tx, estimator.id, client, date, agent.id);
        const check = checkSlot({ rules: rulesOf(client), busy: [...busy, ...held], bookings: booked, now: now() }, start);
        // Return instead of throw so the agent's released hold stays released and the rejection is logged.
        if (!check.ok) return { kind: "rejected" as const, reason: check.reason };
        const hold = {
          id: randomUUID(),
          estimatorId: estimator.id,
          agentId: agent.id,
          start: check.slot.start.toISOString(),
          end: check.slot.end.toISOString(),
          expiresAt: new Date(now().getTime() + HOLD_MINUTES * 60_000).toISOString(),
          createdAt: nowIso,
        };
        tx.insert(holds).values(hold).run();
        tx.insert(auditLog).values({ at: nowIso, actor: agent.id, action: "hold_placed", detail: { holdId: hold.id, estimatorId: estimator.id, start: hold.start } }).run();
        return { kind: "held" as const, hold };
      });
      if (outcome.kind === "rejected") {
        audit(agent.id, "hold_rejected", { estimatorId: estimator.id, start: params.start, reason: outcome.reason });
        throw rejection(outcome.reason);
      }
      return outcome.hold;
    },

    releaseHold(holdId: string, agentId: string) {
      const res = db.delete(holds).where(and(eq(holds.id, holdId), eq(holds.agentId, agentId))).run();
      if (res.changes > 0) audit(agentId, "hold_released", { holdId });
      return res.changes > 0;
    },

    /**
     * The no-force guarantee. Whatever the client sends, the slot is re-validated
     * here against a fresh calendar read, the client rules, saved bookings and
     * other agents' holds, inside one database transaction. Only then is the
     * booking saved and sent to DripJobs.
     */
    async book(raw: unknown) {
      const parsed = bookingRequestSchema.safeParse(raw);
      if (!parsed.success) throw new BookingError("invalid_input", parsed.error.issues.map((i) => i.message).join(". "), 400);
      const req = parsed.data;

      const existing = db.select().from(bookings).where(eq(bookings.idempotencyKey, req.idempotencyKey)).get();
      if (existing) return { booking: existing, duplicate: true };

      const { estimator, client } = load(req.estimatorId);
      const agent = db.select().from(agents).where(eq(agents.id, req.agentId)).get();
      if (!agent) throw new BookingError("not_found", "Agent not found", 404);
      if (!isZipServed(rulesOf(client), req.zip)) {
        audit(agent.id, "booking_rejected", { estimatorId: estimator.id, start: req.start, reason: "zip_not_served" });
        throw rejection("zip_not_served");
      }
      const start = new Date(req.start);
      const date = DateTime.fromJSDate(start, { zone: client.timezone }).toISODate()!;
      const busy = await readCalendar(estimator, client, date);

      let booking: Booking;
      try {
        booking = db.transaction((tx) => {
          const nowIso = now().toISOString();
          const { booked, held } = localBlocks(tx, estimator.id, client, date, agent.id);
          const check = checkSlot({ rules: rulesOf(client), busy: [...busy, ...held], bookings: booked, now: now(), zip: req.zip }, start);
          if (!check.ok) throw rejection(check.reason);
          const row = {
            id: randomUUID(),
            clientId: client.id,
            estimatorId: estimator.id,
            agentId: agent.id,
            start: check.slot.start.toISOString(),
            end: check.slot.end.toISOString(),
            customerName: req.customerName,
            customerPhone: req.customerPhone,
            customerEmail: req.customerEmail || null,
            address: req.address,
            zip: req.zip,
            notes: req.notes || null,
            status: "confirmed" as const,
            dripjobsStatus: "pending" as const,
            dripjobsDetail: null,
            idempotencyKey: req.idempotencyKey,
            createdAt: nowIso,
          };
          tx.insert(bookings).values(row).run();
          tx.delete(holds).where(eq(holds.agentId, agent.id)).run();
          tx.insert(auditLog).values({ at: nowIso, actor: agent.id, action: "booking_confirmed", detail: { bookingId: row.id, estimatorId: estimator.id, start: row.start } }).run();
          return row;
        });
      } catch (err) {
        if (err instanceof BookingError) {
          // Logged after the transaction rolls back, so the record survives.
          audit(agent.id, "booking_rejected", { estimatorId: estimator.id, start: req.start, reason: err.code });
          throw err;
        }
        if (String((err as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) {
          const dup = db.select().from(bookings).where(eq(bookings.idempotencyKey, req.idempotencyKey)).get();
          if (dup) return { booking: dup, duplicate: true };
          audit(agent.id, "booking_rejected", { estimatorId: estimator.id, start: req.start, reason: "conflict", via: "unique_index" });
          throw rejection("conflict");
        }
        throw err;
      }

      const sent = await sendToDripJobs(booking.id, agent.name);
      return { booking: sent, duplicate: false };
    },

    sendToDripJobs,

    cancel(bookingId: string, actor: string) {
      const res = db.update(bookings).set({ status: "cancelled" }).where(and(eq(bookings.id, bookingId), eq(bookings.status, "confirmed"))).run();
      if (res.changes === 0) throw new BookingError("not_found", "Confirmed booking not found", 404);
      audit(actor, "booking_cancelled", { bookingId });
    },

    recentBookings(limit = 100) {
      return db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(limit).all();
    },

    recentAudit(limit = 200) {
      return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all();
    },
  };
}

export type BookingService = ReturnType<typeof createBookingService>;
