import { DateTime } from "luxon";
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

type Db = BetterSQLite3Database<typeof schema>;

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, "0")}`);

export const SEED_CLIENTS: (typeof schema.clients.$inferInsert)[] = [
  {
    id: "desert-coat",
    name: "Desert Coat Painting",
    timezone: "America/Phoenix",
    workDays: [1, 2, 3, 4, 5],
    dayStart: "07:00",
    dayEnd: "16:00",
    slotMinutes: 60,
    stepMinutes: 60,
    bufferMinutes: 30,
    minNoticeMinutes: 120,
    maxPerDay: 4,
    blackoutDates: ["2026-11-26", "2026-12-25", "2027-01-01"],
    allowedZips: range("850", 1, 99).concat(range("852", 1, 99)),
    zapierWebhookUrl: null,
    active: true,
  },
  {
    id: "harbor-line",
    name: "Harbor Line Painters",
    timezone: "America/New_York",
    workDays: [1, 2, 3, 4, 5, 6],
    dayStart: "08:00",
    dayEnd: "17:00",
    slotMinutes: 90,
    stepMinutes: 90,
    bufferMinutes: 15,
    minNoticeMinutes: 24 * 60,
    maxPerDay: 3,
    blackoutDates: ["2026-11-26", "2026-12-24", "2026-12-25"],
    allowedZips: range("100", 1, 40).concat(range("112", 1, 38)),
    zapierWebhookUrl: null,
    active: true,
  },
];

export const SEED_ESTIMATORS: (typeof schema.estimators.$inferInsert)[] = [
  { id: "est-marco", clientId: "desert-coat", name: "Marco Ruiz", email: "marco@desertcoat.example", calendarId: "marco@desertcoat.example", dripjobsUserId: "dj-101" },
  { id: "est-dana", clientId: "desert-coat", name: "Dana Whitfield", email: "dana@desertcoat.example", calendarId: "dana@desertcoat.example", dripjobsUserId: "dj-102" },
  { id: "est-priya", clientId: "harbor-line", name: "Priya Shah", email: "priya@harborline.example", calendarId: "priya@harborline.example", dripjobsUserId: "dj-201" },
  { id: "est-tom", clientId: "harbor-line", name: "Tom Keller", email: "tom@harborline.example", calendarId: "tom@harborline.example", dripjobsUserId: "dj-202" },
];

export const SEED_AGENTS: (typeof schema.agents.$inferInsert)[] = [
  { id: "agent-avery", name: "Avery (AI line)", kind: "ai" },
  { id: "agent-jordan", name: "Jordan Lee", kind: "human" },
  { id: "agent-sam", name: "Sam Patel", kind: "human" },
];

/** The next `count` work days strictly after today in the given zone, skipping blackouts. */
export function upcomingWorkDays(zone: string, workDays: number[], blackout: string[], now: Date, count: number): string[] {
  const out: string[] = [];
  let d = DateTime.fromJSDate(now, { zone }).startOf("day");
  for (let i = 0; i < 60 && out.length < count; i++) {
    d = d.plus({ days: 1 });
    const iso = d.toISODate()!;
    if (workDays.includes(d.weekday) && !blackout.includes(iso)) out.push(iso);
  }
  return out;
}

function block(estimatorId: string, zone: string, date: string, from: string, to: string, title: string, allDay = false) {
  const s = allDay ? DateTime.fromISO(date, { zone }).startOf("day") : DateTime.fromISO(`${date}T${from}`, { zone });
  const e = allDay ? s.plus({ days: 1 }) : DateTime.fromISO(`${date}T${to}`, { zone });
  return { id: `busy-${estimatorId}-${date}-${from}`, estimatorId, title, start: s.toUTC().toISO()!, end: e.toUTC().toISO()!, allDay };
}

/** Sample busy blocks placed on the next few work days so the demo always shows conflicts. */
export function sampleBusy(now: Date): (typeof schema.mockBusy.$inferInsert)[] {
  const [dc, hl] = SEED_CLIENTS;
  const p = upcomingWorkDays(dc.timezone, dc.workDays, dc.blackoutDates, now, 3);
  const n = upcomingWorkDays(hl.timezone, hl.workDays, hl.blackoutDates, now, 4);
  return [
    block("est-marco", dc.timezone, p[0], "10:00", "11:30", "Estimate, Henderson repaint"),
    block("est-marco", dc.timezone, p[1], "13:00", "14:00", "Supplier meeting"),
    block("est-dana", dc.timezone, p[0], "", "", "PTO", true),
    block("est-dana", dc.timezone, p[1], "08:00", "09:00", "Truck service"),
    block("est-priya", hl.timezone, n[1], "11:00", "12:30", "Walkthrough, Pier 9 condo"),
    block("est-priya", hl.timezone, n[2], "", "", "Sherwin Williams training", true),
    block("est-tom", hl.timezone, n[1], "08:00", "17:00", "On site all day, Atlantic Ave"),
    block("est-tom", hl.timezone, n[2], "14:00", "15:00", "Dentist"),
  ];
}

export function seed(db: Db, now = new Date()) {
  db.transaction((tx) => {
    for (const t of ["audit_log", "holds", "bookings", "mock_busy", "estimators", "agents", "clients"]) {
      tx.run(sql.raw(`DELETE FROM ${t}`));
    }
    tx.insert(schema.clients).values(SEED_CLIENTS).run();
    tx.insert(schema.estimators).values(SEED_ESTIMATORS).run();
    tx.insert(schema.agents).values(SEED_AGENTS).run();
    tx.insert(schema.mockBusy).values(sampleBusy(now)).run();
    tx.insert(schema.auditLog).values({ at: now.toISOString(), actor: "system", action: "seed", detail: { clients: SEED_CLIENTS.length } }).run();
  });
}

export function seedIfEmpty(db: Db) {
  const row = db.select({ n: sql<number>`count(*)` }).from(schema.clients).get();
  if (!row || row.n === 0) seed(db);
}
