import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, LogOut, RefreshCw, Users } from "lucide-react";
import { api, getToken, setToken, useMe, waitText, type Account } from "./account";
import { AuthPanel } from "./auth-panel";
import { ThemeToggle, useTheme } from "./theme-toggle";

type Row = {
  email: string;
  createdAt: number;
  lastLogin: number;
  logins: number;
  usedMs: number;
  remainingMs: number;
  resetAt: number | null;
};

type Listing = { ok: true; total: number; online: number; users: Row[] };

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function csvCell(value: string | number): string {
  const text = String(value);
  // Quote everything, and defuse spreadsheet formulas.
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

/** The owner's dashboard: everyone who has registered. Only emails listed in ADMIN_EMAILS get in. */
export function AdminPage() {
  const [theme, setTheme] = useTheme();
  const { me, refresh, signOut } = useMe();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  // Keep this page out of search results.
  useEffect(() => {
    document.title = "Talkivo admin";
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const load = useCallback(async () => {
    if (!getToken()) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<Listing>("/api/admin/users"));
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  const signedIn = me?.account ?? null;
  useEffect(() => {
    if (signedIn?.admin) void load();
  }, [signedIn?.admin, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.users ?? []).filter((u) => !q || u.email.includes(q));
  }, [data, query]);

  function exportCsv() {
    const head = ["Email", "Joined", "Last sign-in", "Sign-ins", "Chat time used (min)", "Time left (min)"];
    const lines = [head.map(csvCell).join(",")];
    for (const u of data?.users ?? []) {
      lines.push(
        [
          u.email,
          new Date(u.createdAt).toISOString(),
          new Date(u.lastLogin).toISOString(),
          u.logins,
          Math.round(u.usedMs / 600) / 100,
          Math.round(u.remainingMs / 600) / 100,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "talkivo-users.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const button =
    "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium";

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-4 sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs tracking-wide text-muted uppercase">Talkivo</p>
          <h1 className="font-display text-3xl italic">Admin</h1>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle theme={theme} onChange={setTheme} />
          {signedIn && (
            <button type="button" className={button} onClick={() => void signOut().then(() => setData(null))}>
              <LogOut className="size-4" />
              Sign out
            </button>
          )}
        </div>
      </header>

      {!signedIn && (
        <section className="mt-6 max-w-sm rounded-xl border border-line bg-surface p-5">
          <h2 className="font-semibold">Sign in to continue</h2>
          <AuthPanel
            intro="Use the admin email address."
            onDone={(account: Account) => {
              void refresh();
              if (account.admin) void load();
            }}
          />
        </section>
      )}

      {signedIn && !signedIn.admin && (
        <section className="mt-6 max-w-md rounded-xl border border-line bg-surface p-5">
          <h2 className="font-semibold">Not an admin account</h2>
          <p className="mt-2 text-sm text-pretty text-muted">
            {signedIn.email} is not on the admin list. Add it to the ADMIN_EMAILS setting, or sign out and use another
            email.
          </p>
          <button
            type="button"
            className={`${button} mt-4`}
            onClick={() => {
              setToken(null);
              void refresh();
            }}
          >
            Use a different email
          </button>
        </section>
      )}

      {signedIn?.admin && (
        <>
          <section className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-sm text-muted">
                <Users className="size-4" /> Registered users
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{data ? data.total : "–"}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm text-muted">Online now</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{data ? data.online : "–"}</p>
            </div>
          </section>

          <section className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search emails"
              aria-label="Search emails"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary"
            />
            <button type="button" className={button} onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button type="button" className={button} onClick={exportCsv} disabled={!data || data.users.length === 0}>
              <Download className="size-4" />
              CSV
            </button>
          </section>

          {error && <p className="mt-3 text-sm text-hot">{error}</p>}

          <section className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Joined</th>
                  <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sign-ins</th>
                  <th className="px-3 py-2.5 text-right font-medium">Chat time</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.email} className="border-b border-line last:border-0">
                    <td className="px-3 py-2.5 break-all">{u.email}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted">{when(u.createdAt)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted">{when(u.lastLogin)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{u.logins}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {u.remainingMs > 0
                        ? `${Math.round(u.usedMs / 60_000)} min used`
                        : u.resetAt
                          ? `used up · back in ${waitText(u.resetAt - Date.now())}`
                          : "used up"}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted">
                      {data ? (query ? "No one matches that search." : "No one has registered yet.") : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <p className="mt-3 text-xs text-muted">
            Showing {shown.length} of {data?.total ?? 0}. Chat time is the current allowance window.
          </p>
        </>
      )}
    </main>
  );
}
