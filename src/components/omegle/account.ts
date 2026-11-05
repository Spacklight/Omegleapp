/**
 * Who is using the app: a device id for guests, or a sign-in token for an
 * account. Every request to the server carries one of them, so the server can
 * apply the right chat-time allowance.
 */
import { useCallback, useEffect, useState } from "react";
import { previewPathPrefix } from "@/lib/preview-path-prefix";
import type { UsageInfo } from "@/lib/omegle/protocol";

const GUEST_KEY = "omegle-guest";
const TOKEN_KEY = "omegle-token";

export type Account = { email: string; admin: boolean };
export type Me = { account: Account | null; usage: UsageInfo };

let memoryGuest: string | null = null;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: fall back to memory */
  }
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** This device's id. It is what a guest's 10 minutes are counted against. */
export function guestId(): string {
  const saved = read(GUEST_KEY);
  if (saved && /^[a-zA-Z0-9_-]{8,64}$/.test(saved)) return saved;
  memoryGuest ??= randomId("g");
  write(GUEST_KEY, memoryGuest);
  return memoryGuest;
}

export function getToken(): string | null {
  return read(TOKEN_KEY);
}

export function setToken(token: string | null) {
  write(TOKEN_KEY, token);
}

export function apiPath(path: string): string {
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
  return `${prefix}${path}`;
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "x-guest": guestId() };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Call the API. Throws an Error carrying the server's message when it says no. */
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiPath(path), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  const record = data && typeof data === "object" ? (data as { ok?: boolean; error?: string }) : null;
  if (!res.ok || !record || record.ok === false) {
    throw new Error(record?.error || "The server did not answer. Try again.");
  }
  return data as T;
}

/** The signed-in account (if any) and chat time left. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me & { ok: true }>("/api/auth/me");
      setMe({ account: data.account, usage: data.usage });
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api("/api/auth/logout", {});
    } catch {
      /* the token is dropped locally either way */
    }
    setToken(null);
    await refresh();
  }, [refresh]);

  return { me, refresh, signOut };
}

/** 4:05 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "1 h 20 min", "12 min", "less than a minute" */
export function waitText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 0) return "a moment";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export type Config = { guestMinutes: number; accountMinutes: number; accountRefreshHours: number };

let cachedConfig: Config = { guestMinutes: 10, accountMinutes: 30, accountRefreshHours: 2 };

/** The allowances the server is using (so the wording matches its settings). */
export function useConfig(): Config {
  const [config, setConfig] = useState<Config>(cachedConfig);
  useEffect(() => {
    let stop = false;
    api<Config & { ok: true }>("/api/config")
      .then((c) => {
        cachedConfig = { guestMinutes: c.guestMinutes, accountMinutes: c.accountMinutes, accountRefreshHours: c.accountRefreshHours };
        if (!stop) setConfig(cachedConfig);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  return config;
}
