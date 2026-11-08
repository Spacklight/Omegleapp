/**
 * Sends and checks the 6-digit email code.
 *
 * Smartbase (smartemail.de5.net) does both: it emails the code, and we ask it
 * whether the code the person typed is right. For Termux without a key there
 * is a development verifier that prints the code in the console instead.
 */
export interface Verifier {
  /** Email a code to this address. Throws if it could not be sent. */
  send(email: string): Promise<void>;
  /** Is this the right code for this address? */
  check(email: string, code: string): Promise<boolean>;
}

type Fetch = typeof fetch;

const YES = new Set(["verified", "valid", "success", "ok", "approved", "confirmed", "true", "passed"]);
const NO = new Set(["invalid", "failed", "fail", "wrong", "expired", "pending", "error", "denied", "rejected", "false", "unverified", "mismatch"]);

/** Read Smartbase's answer: true = code accepted, false = refused, null = we can't tell. */
export function readVerdict(body: unknown): boolean | null {
  if (typeof body === "boolean") return body;
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["valid", "verified", "success", "ok", "isValid", "is_valid", "match"]) {
    if (typeof b[k] === "boolean") return b[k] as boolean;
  }
  for (const k of ["status", "result", "state"]) {
    if (typeof b[k] === "string") {
      const v = (b[k] as string).toLowerCase();
      if (YES.has(v)) return true;
      if (NO.has(v)) return false;
    }
  }
  if (typeof b.error === "string" || (b.error && typeof b.error === "object")) return false;
  const nested = b.data ?? b.result;
  if (nested && typeof nested === "object") return readVerdict(nested);
  return null;
}

export function smartbaseVerifier(opts: { apiKey: string; baseUrl?: string; fetch?: Fetch }): Verifier {
  const base = (opts.baseUrl ?? "https://smartemail.de5.net").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const headers = { "content-type": "application/json", "x-smartbase-key": opts.apiKey };
  return {
    async send(email) {
      const res = await doFetch(`${base}/api/v1/send-verification`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, name: email.split("@")[0] }),
      });
      if (!res.ok) throw new Error(`Smartbase send failed (${res.status})`);
    },
    async check(email, code) {
      const res = await doFetch(`${base}/api/v1/verify-code`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, code }),
      });
      // A refusal (400/401/404/…) means the code is wrong or expired.
      if (res.status >= 400 && res.status < 500) return false;
      if (!res.ok) throw new Error(`Smartbase verify failed (${res.status})`);
      const text = await res.text();
      if (text.trim() === "") return true; // 2xx, no body (e.g. 204): accepted
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Smartbase verify gave an unreadable reply: ${text.slice(0, 120)}`);
      }
      const verdict = readVerdict(body);
      if (verdict === null) {
        // Never guess: an unknown reply must not log anyone in.
        throw new Error(`Smartbase verify gave an unrecognised reply: ${text.slice(0, 200)}`);
      }
      return verdict;
    },
  };
}

/** No email service configured: codes are printed in the server console. For trying it out only. */
export function consoleVerifier(log: (line: string) => void = console.log): Verifier & { codes: Map<string, string> } {
  const codes = new Map<string, string>();
  return {
    codes,
    async send(email) {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      const code = String(bytes[0] % 1_000_000).padStart(6, "0");
      codes.set(email, code);
      log(`[omegle] (no email service set up) verification code for ${email}: ${code}`);
    },
    async check(email, code) {
      const want = codes.get(email);
      if (want && want === code) {
        codes.delete(email);
        return true;
      }
      return false;
    },
  };
}
