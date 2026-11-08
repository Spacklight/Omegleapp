/**
 * Chat-time allowances. Pure functions, no dependencies, shared by the
 * engine (which meters time spent in a chat) and the platform (which decides
 * who gets which allowance).
 */
import type { UsageInfo } from "./protocol.ts";

/** Who is chatting, and what they are allowed. */
export type Who = {
  /** Stable key the used time is stored under, e.g. "g:<deviceId>" or "a:<email>". */
  key: string;
  kind: "guest" | "account";
  allowMs: number;
  /** After the allowance is used up, how long until it comes back. null = never. */
  refreshMs: number | null;
};

export type UsageRec = {
  used: number;
  /** When the allowance ran out (epoch ms), or 0. */
  exhaustedAt: number;
};

export const MINUTE = 60_000;

export function freshRec(): UsageRec {
  return { used: 0, exhaustedAt: 0 };
}

/** Apply a refresh if one is due. Returns true if the record changed. */
export function refreshRec(rec: UsageRec, who: Who, now: number): boolean {
  if (who.refreshMs !== null && rec.exhaustedAt > 0 && now >= rec.exhaustedAt + who.refreshMs) {
    rec.used = 0;
    rec.exhaustedAt = 0;
    return true;
  }
  return false;
}

export function remainingMs(rec: UsageRec, who: Who): number {
  return Math.max(0, who.allowMs - rec.used);
}

export function usageInfo(rec: UsageRec, who: Who): UsageInfo {
  const remaining = remainingMs(rec, who);
  return {
    kind: who.kind,
    allowMs: who.allowMs,
    usedMs: Math.min(rec.used, who.allowMs),
    remainingMs: remaining,
    resetAt: remaining === 0 && who.refreshMs !== null && rec.exhaustedAt > 0 ? rec.exhaustedAt + who.refreshMs : null,
    refreshes: who.refreshMs !== null,
    refreshMs: who.refreshMs,
  };
}

export type QuotaConfig = {
  guestMinutes: number;
  accountMinutes: number;
  accountRefreshHours: number;
};

export const DEFAULT_QUOTA: QuotaConfig = { guestMinutes: 10, accountMinutes: 30, accountRefreshHours: 2 };

export function guestWho(deviceKey: string, cfg: QuotaConfig = DEFAULT_QUOTA): Who {
  return { key: `g:${deviceKey}`, kind: "guest", allowMs: cfg.guestMinutes * MINUTE, refreshMs: null };
}

export function accountWho(email: string, cfg: QuotaConfig = DEFAULT_QUOTA): Who {
  return {
    key: `a:${email}`,
    kind: "account",
    allowMs: cfg.accountMinutes * MINUTE,
    refreshMs: cfg.accountRefreshHours * 60 * MINUTE,
  };
}
