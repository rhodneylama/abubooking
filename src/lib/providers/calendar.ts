import { and, eq, gt, lt } from "drizzle-orm";
import type { BusyBlock } from "@/lib/availability/engine";
import type { Db } from "@/lib/db";
import { mockBusy, type Estimator } from "@/lib/db/schema";

export interface CalendarProvider {
  readonly name: string;
  /** Busy blocks for an estimator that overlap [from, to). Must throw on failure, never return an empty guess. */
  getBusy(estimator: Estimator, from: Date, to: Date): Promise<BusyBlock[]>;
}

export class CalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarUnavailableError";
  }
}

/** Serves busy blocks from the mock_busy table. Used when Google is not configured. */
export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock";
  constructor(private db: Db) {}

  async getBusy(estimator: Estimator, from: Date, to: Date): Promise<BusyBlock[]> {
    const rows = this.db
      .select()
      .from(mockBusy)
      .where(and(eq(mockBusy.estimatorId, estimator.id), lt(mockBusy.start, to.toISOString()), gt(mockBusy.end, from.toISOString())))
      .all();
    return rows.map((r) => ({ start: new Date(r.start), end: new Date(r.end), allDay: r.allDay }));
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfigFromEnv(): GoogleConfig | null {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  const base = (APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: `${base}/api/google/callback` };
}

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.freebusy", "openid", "email"];

export function googleAuthUrl(cfg: GoogleConfig, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeGoogleCode(cfg: GoogleConfig, code: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new CalendarUnavailableError(`Google token exchange failed with ${res.status}`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

/**
 * Reads busy times with the Google Calendar freeBusy endpoint, using the
 * estimator's stored refresh token. freeBusy already excludes events marked
 * "free" (transparent) and declined invitations, which is the behavior we want.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";
  private tokenCache = new Map<string, { token: string; expires: number }>();

  constructor(private cfg: GoogleConfig, private fetchImpl: typeof fetch = fetch) {}

  private async accessToken(estimator: Estimator): Promise<string> {
    if (!estimator.googleRefreshToken) throw new CalendarUnavailableError(`${estimator.name} has not connected Google Calendar`);
    const cached = this.tokenCache.get(estimator.id);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: estimator.googleRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new CalendarUnavailableError(`Google token refresh failed with ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache.set(estimator.id, { token: body.access_token, expires: Date.now() + body.expires_in * 1000 });
    return body.access_token;
  }

  async getBusy(estimator: Estimator, from: Date, to: Date): Promise<BusyBlock[]> {
    const token = await this.accessToken(estimator);
    const res = await this.fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: estimator.calendarId }] }),
    });
    if (!res.ok) throw new CalendarUnavailableError(`Google freeBusy failed with ${res.status}`);
    const body = (await res.json()) as {
      calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
    };
    const cal = body.calendars?.[estimator.calendarId];
    if (!cal) throw new CalendarUnavailableError("Google freeBusy response did not include the calendar");
    // A calendar level error means we cannot see it. Fail closed rather than show the day as open.
    if (cal.errors?.length) throw new CalendarUnavailableError(`Google calendar error ${cal.errors.map((e) => e.reason).join(", ")}`);
    return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
}

/** Pick the provider for an estimator. Google when configured and connected, otherwise the mock. */
export function calendarFor(db: Db, estimator: Estimator): CalendarProvider {
  const cfg = googleConfigFromEnv();
  if (cfg && estimator.googleRefreshToken) return new GoogleCalendarProvider(cfg);
  return new MockCalendarProvider(db);
}
