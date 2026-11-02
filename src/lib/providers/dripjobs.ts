import { DateTime } from "luxon";
import type { Booking, Client, Estimator } from "@/lib/db/schema";

/**
 * Payload sent to Zapier, which creates the DripJobs appointment. Field names
 * are our own; the Zap maps them onto DripJobs fields. See README open questions.
 */
export interface DripJobsPayload {
  booking_id: string;
  idempotency_key: string;
  client_id: string;
  client_name: string;
  estimator_name: string;
  estimator_email: string;
  estimator_dripjobs_id: string | null;
  start_utc: string;
  end_utc: string;
  start_local: string;
  end_local: string;
  timezone: string;
  duration_minutes: number;
  customer_name: string;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  customer_email: string | null;
  address: string;
  zip: string;
  notes: string | null;
  booked_by: string;
  source: "ABU booking widget";
}

export function buildPayload(booking: Booking, client: Client, estimator: Estimator, agentName: string): DripJobsPayload {
  const zone = client.timezone;
  const s = DateTime.fromISO(booking.start, { zone });
  const e = DateTime.fromISO(booking.end, { zone });
  const [first, ...rest] = booking.customerName.trim().split(/\s+/);
  return {
    booking_id: booking.id,
    idempotency_key: booking.idempotencyKey,
    client_id: client.id,
    client_name: client.name,
    estimator_name: estimator.name,
    estimator_email: estimator.email,
    estimator_dripjobs_id: estimator.dripjobsUserId,
    start_utc: s.toUTC().toISO()!,
    end_utc: e.toUTC().toISO()!,
    start_local: s.toISO({ includeOffset: true })!,
    end_local: e.toISO({ includeOffset: true })!,
    timezone: zone,
    duration_minutes: Math.round(e.diff(s, "minutes").minutes),
    customer_name: booking.customerName,
    customer_first_name: first ?? "",
    customer_last_name: rest.join(" "),
    customer_phone: booking.customerPhone,
    customer_email: booking.customerEmail,
    address: booking.address,
    zip: booking.zip,
    notes: booking.notes,
    booked_by: agentName,
    source: "ABU booking widget",
  };
}

export type WriteResult = { ok: true; detail: string } | { ok: false; detail: string; retryable: boolean };

export interface DripJobsWriter {
  readonly name: string;
  send(payload: DripJobsPayload, client: Client): Promise<WriteResult>;
}

/** Records payloads in memory and logs them. Used when no Zapier webhook is configured. */
export class MockDripJobsWriter implements DripJobsWriter {
  readonly name = "mock";
  readonly sent: DripJobsPayload[] = [];
  async send(payload: DripJobsPayload): Promise<WriteResult> {
    this.sent.push(payload);
    if (process.env.NODE_ENV !== "test") console.log("[mock dripjobs] would send", JSON.stringify(payload));
    return { ok: true, detail: "Mock writer, payload logged and not sent" };
  }
}

export interface ZapierOptions {
  defaultUrl?: string;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POSTs the payload to a Zapier catch hook. Retries network errors, 429 and 5xx
 * with exponential backoff. Sends the idempotency key as a header and in the body
 * so the Zap can dedupe if a retry lands after a slow success.
 */
export class ZapierWebhookWriter implements DripJobsWriter {
  readonly name = "zapier";
  private attempts: number;
  private baseDelayMs: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: ZapierOptions = {}) {
    this.attempts = opts.attempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(payload: DripJobsPayload, client: Client): Promise<WriteResult> {
    const url = client.zapierWebhookUrl || this.opts.defaultUrl;
    if (!url) return { ok: false, detail: "No Zapier webhook URL configured for this client", retryable: false };
    let last = "";
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": payload.idempotency_key },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = (await res.text()).slice(0, 500);
        if (res.ok) return { ok: true, detail: `Zapier accepted on attempt ${attempt}. ${text}`.trim() };
        last = `HTTP ${res.status} ${text}`.trim();
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) return { ok: false, detail: last, retryable: false };
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.attempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
    }
    return { ok: false, detail: `Gave up after ${this.attempts} attempts. ${last}`, retryable: true };
  }
}

let mockSingleton: MockDripJobsWriter | undefined;

/** Zapier when ZAPIER_WEBHOOK_URL or the client's own hook is set, otherwise the mock. */
export function writerFor(client: Client): DripJobsWriter {
  const defaultUrl = process.env.ZAPIER_WEBHOOK_URL;
  if (client.zapierWebhookUrl || defaultUrl) return new ZapierWebhookWriter({ defaultUrl });
  mockSingleton ??= new MockDripJobsWriter();
  return mockSingleton;
}
