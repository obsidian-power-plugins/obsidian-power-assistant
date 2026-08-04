import { requestUrl } from "obsidian";

/* Microsoft Graph access: OAuth device-code flow (the user signs in themselves
 * in a browser, so no password ever touches the plugin), a read-only
 * calendarView fetch for the calendar import, and sendMail for sharing a page.
 * Stateless HTTP only; the plugin owns token storage and refresh. Requires an
 * Azure app registration whose client id the user provides in settings,
 * configured as a public client. */

/* Mail.Send joined Calendars.Read here rather than being asked for separately
 * when the first mail is sent. Incremental consent would spare a calendar-only
 * user a permission they never use, but it means a second token to store,
 * refresh, and keep straight, and the refresh token is scoped to whatever was
 * consented anyway. One grant is the honest version: the consent screen names
 * both, so what the plugin can do is legible in one read.
 *
 * The cost is that an existing connection is consented for the old, smaller
 * scope, and Entra will not hand back a token for a scope nobody agreed to, so
 * the refresh fails once with invalid_grant and the user reconnects. That path
 * already exists and already says so, since a dead refresh token looks the
 * same. */
const SCOPE = "offline_access openid profile Calendars.Read Mail.Send";

export interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
	message: string;
}

export interface GraphTokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

const authBase = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0`;

function form(o: Record<string, string>): string {
	return Object.entries(o)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

/** Obsidian's `RequestUrlResponse.json` is a lazy getter that THROWS on a
 *  non-JSON body (an HTML 502, an empty 429). Never let that mask the real
 *  status; return null and let callers treat it as transient. */
function bodyJson(r: { json: unknown }): Record<string, unknown> | null {
	try {
		return (r.json as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

/** An error carrying the OAuth error code, so the caller can tell a rejected
 *  refresh token (reconnect) from a transient network blip (retry). */
export class GraphError extends Error {
	constructor(
		message: string,
		readonly code?: string
	) {
		super(message);
	}
}

/** Begin the device-code flow: returns a code and URL to show the user. */
export async function startDeviceCode(clientId: string, tenant: string): Promise<DeviceCode> {
	const r = await requestUrl({
		url: `${authBase(tenant)}/devicecode`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: form({ client_id: clientId, scope: SCOPE }),
		throw: false,
	});
	if (r.status >= 400) throw new Error((bodyJson(r)?.error_description as string) || `Could not start sign-in (${r.status}).`);
	return r.json as DeviceCode;
}

/** Poll once for tokens. Returns "pending" while the user is still signing in. */
export async function pollToken(clientId: string, tenant: string, deviceCode: string): Promise<GraphTokens | "pending"> {
	const r = await requestUrl({
		url: `${authBase(tenant)}/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode }),
		throw: false,
	});
	if (r.status < 400) return r.json as GraphTokens;
	const j = bodyJson(r);
	if (!j) return "pending"; // a non-JSON 429/5xx blip: keep polling rather than abort sign-in
	const err = j.error as string | undefined;
	if (err === "authorization_pending" || err === "slow_down") return "pending";
	throw new Error((j.error_description as string) || `Sign-in failed (${err || r.status}).`);
}

/** Exchange a refresh token for a fresh access token (and rotated refresh). */
export async function refreshTokens(clientId: string, tenant: string, refreshToken: string): Promise<GraphTokens> {
	const r = await requestUrl({
		url: `${authBase(tenant)}/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: SCOPE }),
		throw: false,
	});
	if (r.status >= 400) {
		const j = bodyJson(r);
		// a server-returned code (invalid_grant, ...) means the refresh token is
		// dead; no code means a transient network failure worth keeping tokens for
		throw new GraphError((j?.error_description as string) || `Session expired; reconnect Microsoft 365 (${r.status}).`, j?.error as string | undefined);
	}
	return r.json as GraphTokens;
}

export interface OutgoingMail {
	to: string[];
	cc?: string[];
	subject: string;
	html: string;
}

/** Send a message as the signed-in user, from their own mailbox, filed in their
 *  own Sent Items like anything else they send.
 *
 *  Graph answers 202 and queues it, so a success here means accepted for
 *  delivery, not delivered: a bad address bounces later, by mail, to them. */
export async function sendMail(accessToken: string, m: OutgoingMail): Promise<void> {
	const box = (a: string) => ({ emailAddress: { address: a } });
	const r = await requestUrl({
		url: "https://graph.microsoft.com/v1.0/me/sendMail",
		method: "POST",
		contentType: "application/json",
		headers: { Authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({
			message: {
				subject: m.subject,
				body: { contentType: "HTML", content: m.html },
				toRecipients: m.to.map(box),
				ccRecipients: (m.cc ?? []).map(box),
			},
			saveToSentItems: true,
		}),
		throw: false,
	});
	if (r.status >= 400) {
		const j = bodyJson(r);
		const err = j?.error as { code?: string; message?: string } | undefined;
		// The tenant, not the sign-in, is the usual reason this one fails: a
		// workplace can withhold Mail.Send while allowing the calendar, and that
		// reads as a permission error rather than a dead session.
		if (r.status === 403) {
			throw new GraphError(err?.message || "Microsoft 365 refused to send this mail. Your organization may not allow this app to send as you.", err?.code);
		}
		throw new GraphError(err?.message || `Could not send the mail (${r.status}).`, err?.code);
	}
}

/** Upcoming events between two ISO instants, in the user's own timezone. */
export async function fetchCalendar(accessToken: string, startISO: string, endISO: string): Promise<unknown[]> {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const select = "subject,start,end,location,organizer,attendees,onlineMeeting,isOnlineMeeting,bodyPreview,body,webLink";
	const url =
		`https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}` +
		`&$orderby=${encodeURIComponent("start/dateTime")}&$top=50&$select=${select}`;
	const r = await requestUrl({
		url,
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}`, Prefer: `outlook.timezone="${tz}"` },
		throw: false,
	});
	if (r.status >= 400) {
		const j = bodyJson(r);
		throw new Error(((j?.error as { message?: string })?.message) || `Could not read your calendar (${r.status}).`);
	}
	return (bodyJson(r)?.value as unknown[]) ?? [];
}
