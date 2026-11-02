import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  workDays: text("work_days", { mode: "json" }).$type<number[]>().notNull(),
  dayStart: text("day_start").notNull(),
  dayEnd: text("day_end").notNull(),
  slotMinutes: integer("slot_minutes").notNull(),
  stepMinutes: integer("step_minutes"),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  minNoticeMinutes: integer("min_notice_minutes").notNull().default(0),
  maxPerDay: integer("max_per_day").notNull().default(0),
  blackoutDates: text("blackout_dates", { mode: "json" }).$type<string[]>().notNull(),
  allowedZips: text("allowed_zips", { mode: "json" }).$type<string[]>().notNull(),
  /** Per client Zapier catch hook. Falls back to ZAPIER_WEBHOOK_URL when empty. */
  zapierWebhookUrl: text("zapier_webhook_url"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const estimators = sqliteTable("estimators", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => clients.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  /** Google calendar id, usually the estimator's email. */
  calendarId: text("calendar_id").notNull(),
  googleRefreshToken: text("google_refresh_token"),
  /** DripJobs user or crew identifier passed through to Zapier. */
  dripjobsUserId: text("dripjobs_user_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["human", "ai"] }).notNull().default("human"),
});

export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id),
    estimatorId: text("estimator_id").notNull().references(() => estimators.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    start: text("start").notNull(),
    end: text("end").notNull(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email"),
    address: text("address").notNull(),
    zip: text("zip").notNull(),
    notes: text("notes"),
    status: text("status", { enum: ["confirmed", "cancelled"] }).notNull().default("confirmed"),
    dripjobsStatus: text("dripjobs_status", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"),
    dripjobsDetail: text("dripjobs_detail"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("bookings_idem").on(t.idempotencyKey),
    // Database level backstop. Two confirmed bookings can never share an estimator and start time.
    uniqueIndex("bookings_no_double").on(t.estimatorId, t.start).where(sql`status = 'confirmed'`),
    index("bookings_estimator_start").on(t.estimatorId, t.start),
  ],
);

export const holds = sqliteTable("holds", {
  id: text("id").primaryKey(),
  estimatorId: text("estimator_id").notNull().references(() => estimators.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  start: text("start").notNull(),
  end: text("end").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Busy blocks served by the mock calendar provider. Lets the demo run without Google. */
export const mockBusy = sqliteTable("mock_busy", {
  id: text("id").primaryKey(),
  estimatorId: text("estimator_id").notNull().references(() => estimators.id),
  title: text("title").notNull(),
  start: text("start").notNull(),
  end: text("end").notNull(),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
});

export type Client = typeof clients.$inferSelect;
export type Estimator = typeof estimators.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Hold = typeof holds.$inferSelect;
export type MockBusy = typeof mockBusy.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
