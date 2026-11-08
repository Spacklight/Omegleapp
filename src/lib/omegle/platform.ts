/**
 * The whole HTTP API, shared by the Node/Termux server and the Cloudflare
 * Durable Object: lobby (/api/omegle), accounts (/api/auth/*), the admin
 * dashboard's data (/api/admin/users) and app settings (/api/config).
 *
 * Time limits: someone with no account gets GUEST_MINUTES of chat in total,
 * for good. A signed-in account gets ACCOUNT_MINUTES, and once that is used
 * up it comes back ACCOUNT_REFRESH_HOURS later.
 */
import { Accounts, cleanEmail } from "./accounts.ts";
import { LobbyEngine } from "./engine.ts";
import {
  DEFAULT_QUOTA,
  accountWho,
  freshRec,
  guestWho,
  refreshRec,
  usageInfo,
  type QuotaConfig,
  type UsageRec,
  type Who,
} from "./quota.ts";
import type { Store } from "./store.ts";
import type { Verifier } from "./verifier.ts";

export type PlatformEnv = {
  ADMIN_EMAILS?: string;
  ANDROID_APP_URL?: string;
  GUEST_MINUTES?: string;
  ACCOUNT_MINUTES?: string;
  ACCOUNT_REFRESH_HOURS?: string;
};

const SAVE_EVERY_MS = 30_000;
const ID = /^[a-zA-Z0-9_-]{8,64}$/;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export class Platform {
  readonly engine: LobbyEngine;
  readonly accounts: Accounts;
  readonly quota: QuotaConfig;
  private readonly store: Store;
  private readonly env: PlatformEnv;
  private readonly clock: () => number;
  private readonly admins: string[];
  private lastSaved = new Map<string, number>();

  constructor(opts: { store: Store; verifier: Verifier; env?: PlatformEnv; clock?: () => number }) {
    this.env = opts.env ?? {};
    this.store = opts.store;
    this.clock = opts.clock ?? Date.now;
    this.engine = new LobbyEngine(this.clock);
    this.admins = (this.env.ADMIN_EMAILS ?? "")
      .split(/[,\s;]+/)
      .map((e) => cleanEmail(e))
      .filter((e): e is string => !!e);
    this.accounts = new Accounts(opts.store, opts.verifier, this.clock, this.admins);
    this.quota = {
      guestMinutes: num(this.env.GUEST_MINUTES, DEFAULT_QUOTA.guestMinutes),
      accountMinutes: num(this.env.ACCOUNT_MINUTES, DEFAULT_QUOTA.accountMinutes),
      accountRefreshHours: num(this.env.ACCOUNT_REFRESH_HOURS, DEFAULT_QUOTA.accountRefreshHours),
    };
  }

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";

      if (path === "/api/omegle") return await this.lobby(request, ip);
      if (path === "/api/config") return this.config();
      if (path === "/api/auth/me") return await this.me(request, ip);
      if (path === "/api/auth/start" || path === "/api/auth/verify" || path === "/api/auth/logout") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
        const body = await this.readBody(request);
        if (!body) return json({ ok: false, error: "Invalid JSON." }, 400);
        if (path === "/api/auth/start") return this.send(await this.accounts.start(body.email, ip));
        if (path === "/api/auth/verify") return this.send(await this.accounts.verify(body.email, body.code));
        await this.accounts.logout(this.bearer(request));
        return json({ ok: true });
      }
      if (path === "/api/admin/users") return await this.adminUsers(request);
      return json({ ok: false, error: "Not found." }, 404);
    } catch (error) {
      console.error("[omegle]", error);
      return json({ ok: false, error: "Something went wrong. Try again." }, 500);
    }
  }

  // ---- helpers --------------------------------------------------------------

  private send(result: { ok: boolean; status?: number; error?: string } & Record<string, unknown>): Response {
    if (result.ok) return json(result);
    return json({ ok: false, error: result.error }, result.status ?? 400);
  }

  private bearer(request: Request): string | null {
    const header = request.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  }

  private async readBody(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const text = await request.text();
      if (text.length > 64_000) return null;
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Who is asking, and which allowance applies. A valid sign-in token wins; otherwise they are a guest. */
  private async whoFor(request: Request, ip: string): Promise<{ who: Who; email: string | null }> {
    const email = await this.accounts.session(this.bearer(request));
    if (email) return { who: accountWho(email, this.quota), email };
    const guest = request.headers.get("x-guest") ?? "";
    // No device id (very old client): fall back to the network address.
    const key = ID.test(guest) ? guest : `ip-${ip}`;
    return { who: guestWho(key, this.quota), email: null };
  }

  /** Load someone's saved used time before their first request. */
  private async ensureUsage(who: Who) {
    if (this.engine.hasUsage(who.key)) return;
    const saved = await this.store.get<UsageRec>(`usage:${who.key}`);
    this.engine.seedUsage(who.key, saved ?? freshRec());
  }

  private async flush() {
    const now = this.clock();
    const done: string[] = [];
    for (const { key, rec, urgent } of this.engine.takeDirtyUsage()) {
      if (urgent || now - (this.lastSaved.get(key) ?? 0) >= SAVE_EVERY_MS) {
        await this.store.put(`usage:${key}`, rec);
        this.lastSaved.set(key, now);
        done.push(key);
      }
    }
    this.engine.clearDirtyUsage(done);
  }

  // ---- routes ---------------------------------------------------------------

  private async lobby(request: Request, ip: string): Promise<Response> {
    if (request.method === "GET") return json(this.engine.stats());
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
    const raw = await this.readBody(request);
    if (!raw) return json({ ok: false, error: "Invalid JSON." }, 400);
    const { who } = await this.whoFor(request, ip);
    await this.ensureUsage(who);
    // Polls may be held open until there is news (long polling); `signal` frees the wait if the browser hangs up.
    const result = await this.engine.handleAsync(raw, { signal: request.signal, who });
    await this.flush();
    return json(result.body, result.status);
  }

  private config(): Response {
    return json({
      ok: true,
      androidAppUrl: (this.env.ANDROID_APP_URL ?? "").trim() || null,
      guestMinutes: this.quota.guestMinutes,
      accountMinutes: this.quota.accountMinutes,
      accountRefreshHours: this.quota.accountRefreshHours,
    });
  }

  private async me(request: Request, ip: string): Promise<Response> {
    const { who, email } = await this.whoFor(request, ip);
    await this.ensureUsage(who);
    return json({
      ok: true,
      account: email ? { email, admin: this.accounts.isAdmin(email) } : null,
      usage: this.engine.usageFor(who),
    });
  }

  private async adminUsers(request: Request): Promise<Response> {
    const email = await this.accounts.session(this.bearer(request));
    if (!email) return json({ ok: false, error: "Sign in first." }, 401);
    if (!this.accounts.isAdmin(email)) return json({ ok: false, error: "This account is not an admin." }, 403);
    const now = this.clock();
    const [accounts, usage] = await Promise.all([
      this.accounts.list(),
      this.store.list<UsageRec>("usage:a:"),
    ]);
    const used = new Map(usage.map(([k, v]) => [k.slice("usage:a:".length), v]));
    const users = accounts.map((a) => {
      const who = accountWho(a.email, this.quota);
      const live = this.engine.hasUsage(who.key) ? this.engine.usageFor(who) : null;
      const saved = used.get(a.email);
      let info = live;
      if (!info) {
        const rec = saved ? { ...saved } : freshRec();
        refreshRec(rec, who, now);
        info = usageInfo(rec, who);
      }
      return { ...a, usedMs: info.usedMs, remainingMs: info.remainingMs, resetAt: info.resetAt };
    });
    const stats = this.engine.stats();
    return json({ ok: true, total: users.length, online: stats.online, users });
  }
}
