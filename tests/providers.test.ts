import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarProvider, CalendarUnavailableError, googleAuthUrl } from "@/lib/providers/calendar";
import { ZapierWebhookWriter, buildPayload, type DripJobsPayload } from "@/lib/providers/dripjobs";
import type { Booking, Client, Estimator } from "@/lib/db/schema";

const estimator: Estimator = { id: "e1", clientId: "c1", name: "Marco Ruiz", email: "m@x.com", calendarId: "m@x.com", googleRefreshToken: "rt", dripjobsUserId: "dj-1", active: true };
const client = { id: "c1", name: "Desert Coat", timezone: "America/Phoenix", zapierWebhookUrl: "https://hooks.zapier.com/hooks/catch/1/abc" } as Client;
const cfg = { clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:3000/api/google/callback" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GoogleCalendarProvider", () => {
  it("refreshes a token and maps freeBusy blocks", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "at", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ calendars: { "m@x.com": { busy: [{ start: "2026-11-10T17:00:00Z", end: "2026-11-10T18:30:00Z" }] } } }));
    const p = new GoogleCalendarProvider(cfg, fetchImpl as unknown as typeof fetch);
    const busy = await p.getBusy(estimator, new Date("2026-11-10T00:00:00Z"), new Date("2026-11-11T00:00:00Z"));
    expect(busy).toEqual([{ start: new Date("2026-11-10T17:00:00Z"), end: new Date("2026-11-10T18:30:00Z") }]);
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers.authorization).toBe("Bearer at");
    expect(JSON.parse(init.body)).toMatchObject({ items: [{ id: "m@x.com" }] });
  });
  it("caches the access token between calls", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "at", expires_in: 3600 }))
      .mockImplementation(async () => json({ calendars: { "m@x.com": { busy: [] } } }));
    const p = new GoogleCalendarProvider(cfg, fetchImpl as unknown as typeof fetch);
    await p.getBusy(estimator, new Date(), new Date());
    await p.getBusy(estimator, new Date(), new Date());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("fails closed on a calendar level error", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "at", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ calendars: { "m@x.com": { errors: [{ reason: "notFound" }] } } }));
    const p = new GoogleCalendarProvider(cfg, fetchImpl as unknown as typeof fetch);
    await expect(p.getBusy(estimator, new Date(), new Date())).rejects.toBeInstanceOf(CalendarUnavailableError);
  });
  it("fails closed when the token refresh is refused", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    const p = new GoogleCalendarProvider(cfg, fetchImpl as unknown as typeof fetch);
    await expect(p.getBusy(estimator, new Date(), new Date())).rejects.toThrow(/refresh failed/);
  });
  it("fails closed when the estimator never connected", async () => {
    const p = new GoogleCalendarProvider(cfg, vi.fn() as unknown as typeof fetch);
    await expect(p.getBusy({ ...estimator, googleRefreshToken: null }, new Date(), new Date())).rejects.toThrow(/not connected/);
  });
  it("builds an offline consent URL with the freebusy scope", () => {
    const url = new URL(googleAuthUrl(cfg, "state1"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("calendar.freebusy");
    expect(url.searchParams.get("state")).toBe("state1");
  });
});

describe("ZapierWebhookWriter", () => {
  const payload = { idempotency_key: "idem-123", booking_id: "b1" } as DripJobsPayload;
  const noSleep = async () => {};

  it("posts JSON with the idempotency key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"status":"success"}', { status: 200 }));
    const w = new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const r = await w.send(payload, client);
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(client.zapierWebhookUrl);
    expect(init.headers["idempotency-key"]).toBe("idem-123");
    expect(JSON.parse(init.body).booking_id).toBe("b1");
  });
  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const w = new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep, baseDelayMs: 100 });
    const r = await w.send(payload, client);
    expect(r.ok).toBe(true);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([100, 200]);
  });
  it("does not retry a 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    const w = new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const r = await w.send(payload, client);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retries 429 and gives up after the attempt limit", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("slow down", { status: 429 }));
    const w = new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, attempts: 3 });
    const r = await w.send(payload, client);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("falls back to the default URL and fails clearly with none", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("ok"));
    const w = new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch, defaultUrl: "https://hooks.example/default" });
    await w.send(payload, { ...client, zapierWebhookUrl: null });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hooks.example/default");
    const none = await new ZapierWebhookWriter({ fetchImpl: fetchImpl as unknown as typeof fetch }).send(payload, { ...client, zapierWebhookUrl: null });
    expect(none).toMatchObject({ ok: false, retryable: false });
  });
});

describe("buildPayload", () => {
  it("includes local and UTC times and splits the customer name", () => {
    const booking = { id: "b1", idempotencyKey: "k", start: "2026-11-10T19:00:00.000Z", end: "2026-11-10T20:00:00.000Z", customerName: "Rosa  Maria Delgado", customerPhone: "1", customerEmail: null, address: "a", zip: "85014", notes: null } as Booking;
    const p = buildPayload(booking, client, estimator, "Jordan Lee");
    expect(p).toMatchObject({ start_local: "2026-11-10T12:00:00.000-07:00", start_utc: "2026-11-10T19:00:00.000Z", duration_minutes: 60, customer_first_name: "Rosa", customer_last_name: "Maria Delgado", estimator_dripjobs_id: "dj-1", booked_by: "Jordan Lee" });
  });
});
