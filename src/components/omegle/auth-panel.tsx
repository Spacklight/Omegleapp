import { useEffect, useRef, useState } from "react";
import { api, setToken, type Account } from "./account";

/**
 * Create an account or sign in: type your email, get a 6-digit code, type it.
 * Same two steps either way — a new email simply becomes a new account.
 */
export function AuthPanel({ onDone, intro }: { onDone: (account: Account) => void; intro?: string }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cool, setCool] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cool <= 0) return;
    const id = setTimeout(() => setCool((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cool]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/start", { email: email.trim() });
      setStep("code");
      setCode("");
      setCool(45);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ ok: true; token: string; account: { email: string } }>("/api/auth/verify", {
        email: email.trim(),
        code: code.replace(/\s+/g, ""),
      });
      setToken(data.token);
      const me = await api<{ ok: true; account: Account | null }>("/api/auth/me");
      onDone(me.account ?? { email: data.account.email, admin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the code.");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
  const primary =
    "inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 font-semibold text-primary-fg transition-transform duration-150 ease-out active:scale-[0.98] disabled:opacity-50";

  return (
    <div className="mt-4 space-y-3">
      {intro && <p className="text-sm text-pretty text-muted">{intro}</p>}
      {step === "email" ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode();
          }}
        >
          <label className="block text-sm text-muted" htmlFor="auth-email">
            Your email address
          </label>
          <input
            id="auth-email"
            ref={input}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={field}
            required
          />
          <button type="submit" disabled={busy || !email.includes("@")} className={primary}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
          <p className="text-xs text-pretty text-muted">
            No password. We email a 6-digit code to confirm it’s you. New here? This creates your account.
          </p>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p className="text-sm text-pretty text-muted">
            We sent a 6-digit code to <span className="font-medium text-fg">{email.trim()}</span>. It can take a minute.
          </p>
          <label className="sr-only" htmlFor="auth-code">
            6-digit code
          </label>
          <input
            id="auth-code"
            ref={input}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ""))}
            className={`${field} text-center text-2xl tracking-[0.4em] tabular-nums`}
          />
          <button type="submit" disabled={busy || code.replace(/\s+/g, "").length !== 6} className={primary}>
            {busy ? "Checking…" : "Verify and continue"}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="min-h-11 text-muted underline"
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              Use a different email
            </button>
            <button
              type="button"
              disabled={cool > 0 || busy}
              className="min-h-11 text-primary underline disabled:text-muted disabled:no-underline"
              onClick={() => void sendCode()}
            >
              {cool > 0 ? `Send again in ${cool}s` : "Send again"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-hot">
          {error}
        </p>
      )}
    </div>
  );
}
