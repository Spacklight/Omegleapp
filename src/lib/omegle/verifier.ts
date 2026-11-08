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
      if (!res.ok) return false;
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        return true; // 2xx with no body: accepted
      }
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        for (const k of ["valid", "verified", "success", "ok"]) {
          if (typeof b[k] === "boolean") return b[k] as boolean;
        }
        if (typeof b.status === "string") return ["verified", "valid", "success", "ok"].includes(b.status.toLowerCase());
      }
      return true;
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
