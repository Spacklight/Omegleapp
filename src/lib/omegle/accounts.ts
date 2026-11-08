/**
 * Accounts: sign up / sign in with just an email address and a 6-digit code.
 * The code is emailed and checked by the Verifier (Smartbase). We keep the
 * account record, and hand back a long random session token that the app
 * sends with each request.
 */
import type { Store } from "./store.ts";
import type { Verifier } from "./verifier.ts";

export type Account = {
  email: string;
  createdAt: number;
  lastLogin: number;
  logins: number;
};

type Token = { email: string; exp: number };

export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const TOKEN_DAYS = 30;
const SEND_GAP_MS = 45_000; // between codes to the same address
const SEND_PER_HOUR = 5; // per address
const IP_PER_HOUR = 20; // codes requested from one network address
const WRONG_MAX = 6; // wrong codes before a pause
const WRONG_PAUSE_MS = 10 * 60_000;
const HOUR = 3_600_000;

/** Same answer for "not an admin" and "unknown": the admin page does not say which emails are admins. */
const NOT_ADMIN = { ok: false, status: 403, error: "This email is not allowed to open the admin page." } as const;

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function cleanEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Accounts {
  private sends = new Map<string, number[]>();
  private ipSends = new Map<string, number[]>();
  private wrong = new Map<string, { n: number; until: number }>();
  private sessions = new Map<string, Token>(); // hash -> token, a cache over the store

  private readonly store: Store;
  private readonly verifier: Verifier;
  private readonly clock: () => number;
  private readonly admins: string[];

  constructor(store: Store, verifier: Verifier, clock: () => number, admins: string[]) {
    this.store = store;
    this.verifier = verifier;
    this.clock = clock;
    this.admins = admins;
  }

  isAdmin(email: string): boolean {
    return this.admins.includes(email);
  }

  /** Email a code to this address. With `adminOnly`, only admin emails are accepted (and nothing is sent to anyone else). */
  async start(rawEmail: unknown, ip: string, adminOnly = false): Promise<Result<{ sent: true }>> {
    const email = cleanEmail(rawEmail);
    if (!email) return { ok: false, status: 400, error: "Enter a valid email address." };
    if (adminOnly && !this.isAdmin(email)) return NOT_ADMIN;
    const now = this.clock();

    const mine = (this.sends.get(email) ?? []).filter((t) => now - t < HOUR);
    if (mine.length > 0 && now - mine[mine.length - 1] < SEND_GAP_MS) {
      return { ok: false, status: 429, error: "A code was just sent. Wait a little before asking for another." };
    }
    if (mine.length >= SEND_PER_HOUR) {
      return { ok: false, status: 429, error: "Too many codes for this address. Try again in an hour." };
    }
    const theirs = (this.ipSends.get(ip) ?? []).filter((t) => now - t < HOUR);
    if (theirs.length >= IP_PER_HOUR) {
      return { ok: false, status: 429, error: "Too many requests from your network. Try again later." };
    }

    try {
      await this.verifier.send(email);
    } catch (error) {
      console.error("[omegle] could not send code:", error);
      return { ok: false, status: 502, error: "We could not send the email. Try again in a moment." };
    }
    mine.push(now);
    theirs.push(now);
    this.sends.set(email, mine);
    this.ipSends.set(ip, theirs);
    this.wrong.delete(email);
    return { ok: true, sent: true };
  }

  /** Check the code; on success create the account (first time) and return a session token. */
  async verify(rawEmail: unknown, rawCode: unknown, adminOnly = false): Promise<Result<{ token: string; account: Account }>> {
    const email = cleanEmail(rawEmail);
    const code = String(rawCode ?? "").replace(/\s+/g, "");
    if (!email || !/^\d{6}$/.test(code)) return { ok: false, status: 400, error: "Enter the 6-digit code." };
    if (adminOnly && !this.isAdmin(email)) return NOT_ADMIN;
    const now = this.clock();

    const w = this.wrong.get(email);
    if (w && w.n >= WRONG_MAX && now < w.until) {
      return { ok: false, status: 429, error: "Too many wrong codes. Wait a few minutes, then ask for a new code." };
    }

    let good = false;
    try {
      good = await this.verifier.check(email, code);
    } catch (error) {
      console.error("[omegle] could not check code:", error);
      return { ok: false, status: 502, error: "We could not check the code. Try again in a moment." };
    }
    if (!good) {
      const n = (w && now < w.until + WRONG_PAUSE_MS ? w.n : 0) + 1;
      this.wrong.set(email, { n, until: now + WRONG_PAUSE_MS });
      return { ok: false, status: 401, error: "That code is not right, or it has expired." };
    }
    this.wrong.delete(email);

    const key = `acct:${email}`;
    const existing = await this.store.get<Account>(key);
    const account: Account = existing
      ? { ...existing, lastLogin: now, logins: existing.logins + 1 }
      : { email, createdAt: now, lastLogin: now, logins: 1 };
    await this.store.put(key, account);

    const token = randomToken();
    const hash = await sha256(token);
    const record: Token = { email, exp: now + TOKEN_DAYS * 24 * HOUR };
    await this.store.put(`tok:${hash}`, record);
    this.sessions.set(hash, record);
    return { ok: true, token, account };
  }

  /** Who does this token belong to? */
  async session(token: string | null): Promise<string | null> {
    if (!token || token.length < 32 || token.length > 200) return null;
    const hash = await sha256(token);
    const now = this.clock();
    let record = this.sessions.get(hash);
    if (!record) {
      record = await this.store.get<Token>(`tok:${hash}`);
      if (record) this.sessions.set(hash, record);
    }
    if (!record) return null;
    if (record.exp <= now) {
      this.sessions.delete(hash);
      await this.store.delete(`tok:${hash}`);
      return null;
    }
    return record.email;
  }

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const hash = await sha256(token);
    this.sessions.delete(hash);
    await this.store.delete(`tok:${hash}`);
  }

  /** Every registered account, newest first. */
  async list(): Promise<Account[]> {
    const rows = await this.store.list<Account>("acct:");
    return rows.map(([, a]) => a).sort((a, b) => b.createdAt - a.createdAt);
  }
}
