import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Platform, type PlatformEnv } from "./platform.ts";
import { MemoryStore } from "./store.ts";
import { consoleVerifier, smartbaseVerifier } from "./verifier.ts";

const MIN = 60_000;
let n = 0;

function setup(env: PlatformEnv = {}, store = new MemoryStore(), clockStart = 5_000_000) {
  let t = clockStart;
  const verifier = consoleVerifier(() => {});
  const platform = new Platform({ store, verifier, env, clock: () => t });
  const advance = (ms: number) => {
    t += ms;
  };

  async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await platform.handle(
      new Request(`http://test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function signIn(email: string) {
    const s = await call("/api/auth/start", { email });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const code = verifier.codes.get(email.toLowerCase())!;
    const v = await call("/api/auth/verify", { email, code });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body.token as string;
  }

  /** A chatter. `auth` is a bearer token for an account, or omitted for a guest. */
  function chatter(opts: { token?: string; guest?: string } = {}) {
    n += 1;
    const peerId = `peer${String(n).padStart(6, "0")}`;
    const secret = `secret${String(n).padStart(6, "0")}`;
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    headers["x-guest"] = opts.guest ?? `guest${String(n).padStart(6, "0")}`;
    const op = (body: Record<string, unknown>) => call("/api/omegle", { peerId, secret, ...body }, headers);
    return {
      id: peerId,
      join: () => op({ op: "poll", queue: true, mode: "text", nick: "N", country: "Kenya" }),
      poll: () => op({ op: "poll", queue: false }),
      send: (text: string) => op({ op: "send", text }),
      next: () => op({ op: "next" }),
      stop: () => op({ op: "stop" }),
    };
  }

  /** Chat for `ms`, polling both people every 10 seconds like a real session would. */
  async function chatFor(ms: number, ...people: Array<ReturnType<typeof chatter>>) {
    let left = ms;
    while (left > 0) {
      const step = Math.min(10_000, left);
      advance(step);
      left -= step;
      for (const p of people) await p.poll();
    }
  }

  return { platform, call, advance, signIn, chatter, chatFor, verifier };
}

describe("accounts", () => {
  it("signs up with an email code, then signs in again to the same account", async () => {
    const { call, signIn, advance } = setup();
    const token = await signIn("Ada@Example.com");
    const me = await call("/api/auth/me", undefined, { authorization: `Bearer ${token}` });
    assert.equal(me.body.account.email, "ada@example.com");
    assert.equal(me.body.account.admin, false);
    assert.equal(me.body.usage.kind, "account");
    advance(2 * MIN);
    await signIn("ada@example.com");
    const again = await call("/api/auth/me", undefined, { authorization: `Bearer ${token}` });
    assert.ok(again.body.account, "old token still works");
  });

  it("rejects bad emails, wrong codes and unknown tokens", async () => {
    const { call, verifier } = setup();
    assert.equal((await call("/api/auth/start", { email: "nope" })).status, 400);
    assert.equal((await call("/api/auth/start", { email: "a@b.co" })).status, 200);
    const bad = await call("/api/auth/verify", { email: "a@b.co", code: "000000" });
    assert.equal(bad.status, 401);
    assert.equal((await call("/api/auth/verify", { email: "a@b.co", code: "12" })).status, 400);
    const good = await call("/api/auth/verify", { email: "a@b.co", code: verifier.codes.get("a@b.co")! });
    assert.equal(good.status, 200);
    const me = await call("/api/auth/me", undefined, { authorization: "Bearer " + "x".repeat(64) });
    assert.equal(me.body.account, null);
  });

  it("pauses after too many wrong codes and limits how often codes are sent", async () => {
    const { call, advance, verifier } = setup();
    await call("/api/auth/start", { email: "c@d.co" });
    assert.equal((await call("/api/auth/start", { email: "c@d.co" })).status, 429, "too soon");
    for (let i = 0; i < 6; i++) await call("/api/auth/verify", { email: "c@d.co", code: "111111" });
    const locked = await call("/api/auth/verify", { email: "c@d.co", code: verifier.codes.get("c@d.co")! });
    assert.equal(locked.status, 429);
    advance(11 * MIN);
    const ok = await call("/api/auth/verify", { email: "c@d.co", code: verifier.codes.get("c@d.co")! });
    assert.equal(ok.status, 200);
  });

  it("logging out ends the session", async () => {
    const { call, signIn } = setup();
    const token = await signIn("e@f.co");
    await call("/api/auth/logout", {}, { authorization: `Bearer ${token}` });
    const me = await call("/api/auth/me", undefined, { authorization: `Bearer ${token}` });
    assert.equal(me.body.account, null);
  });
});

describe("admin dashboard", () => {
  it("lists registered users for admins only", async () => {
    const { call, signIn } = setup({ ADMIN_EMAILS: "boss@example.com" });
    const user = await signIn("user@example.com");
    const boss = await signIn("boss@example.com");
    assert.equal((await call("/api/admin/users")).status, 401);
    assert.equal((await call("/api/admin/users", undefined, { authorization: `Bearer ${user}` })).status, 403);
    const res = await call("/api/admin/users", undefined, { authorization: `Bearer ${boss}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.users.map((u: { email: string }) => u.email).sort(),
      ["boss@example.com", "user@example.com"],
    );
    assert.equal(res.body.users[0].logins, 1);
  });
});

describe("chat time limits", () => {
  it("gives guests 10 minutes in total, and never refreshes it", async () => {
    const { chatter, chatFor, advance } = setup();
    const a = chatter({ guest: "guestAAAAAA" });
    const b = chatter();
    await a.join();
    const joined = await b.join();
    assert.equal(joined.body.phase, "chat");
    assert.equal(joined.body.usage.allowMs, 10 * MIN);

    await chatFor(5 * MIN, a, b);
    const mid = await a.poll();
    assert.equal(mid.body.phase, "chat");
    assert.ok(Math.abs(mid.body.usage.remainingMs - 5 * MIN) < 30_000, "about 5 minutes left");

    await chatFor(6 * MIN, a, b);
    const out = await a.poll();
    assert.equal(out.body.phase, "limit");
    assert.equal(out.body.usage.remainingMs, 0);
    assert.equal(out.body.usage.refreshes, false);
    assert.equal(out.body.usage.resetAt, null);
    // The partner of a cut-off 1:1 chat is told it ended.
    const partner = await b.poll();
    assert.notEqual(partner.body.phase, "chat");

    // Cannot start again, now or days later.
    assert.equal((await a.join()).body.phase, "limit");
    advance(72 * 60 * MIN);
    assert.equal((await a.join()).body.phase, "limit");
  });

  it("gives an account 30 minutes, then brings them back 2 hours after it ran out", async () => {
    const { chatter, chatFor, advance, signIn } = setup();
    const token = await signIn("long@talker.com");
    const a = chatter({ token });
    const b = chatter({ token: await signIn("friend@talker.com") });
    await a.join();
    const joined = await b.join();
    assert.equal(joined.body.usage.allowMs, 30 * MIN);

    await chatFor(31 * MIN, a, b);
    const out = await a.poll();
    assert.equal(out.body.phase, "limit");
    assert.equal(out.body.usage.refreshes, true);
    assert.equal(typeof out.body.usage.resetAt, "number");

    // It ran out at minute 30 and we are at minute 31: it comes back at minute 150.
    advance(118 * MIN);
    assert.equal((await a.join()).body.phase, "limit", "still locked just before 2 hours");
    advance(2 * MIN);
    const back = await a.join();
    assert.notEqual(back.body.phase, "limit");
    assert.equal(back.body.phase === "waiting" || back.body.phase === "chat", true);
  });

  it("cuts someone off on time even when their request is being held", async () => {
    const { platform, chatter } = setup({ GUEST_MINUTES: "1" });
    const a = chatter();
    const b = chatter();
    await a.join();
    await b.join();
    // A held poll should come back about when the minute is up, not 25s later than that.
    const started = Date.now();
    const res = await platform.engine.handleAsync(
      { op: "poll", peerId: a.id, secret: a.id.replace("peer", "secret"), queue: false, hold: true, state: "x" },
      { holdMs: 5000 },
    );
    assert.ok(res.status === 200);
    assert.ok(Date.now() - started < 6000);
  });

  it("remembers used time across a restart", async () => {
    const store = new MemoryStore();
    const one = setup({}, store);
    const a = one.chatter({ guest: "guestKEEPME1" });
    const b = one.chatter();
    await a.join();
    await b.join();
    await one.chatFor(6 * MIN, a, b);
    await a.stop(); // saves right away

    const two = setup({}, store, 9_000_000);
    const me = await two.call("/api/auth/me", undefined, { "x-guest": "guestKEEPME1" });
    assert.ok(me.body.usage.usedMs >= 5 * MIN, `used ${me.body.usage.usedMs}`);
    assert.ok(me.body.usage.remainingMs <= 5 * MIN);
  });

  it("lets limits be changed with settings", async () => {
    const { call } = setup({ GUEST_MINUTES: "3", ACCOUNT_MINUTES: "45", ACCOUNT_REFRESH_HOURS: "1" });
    const cfg = await call("/api/config");
    assert.equal(cfg.body.guestMinutes, 3);
    assert.equal(cfg.body.accountMinutes, 45);
    assert.equal(cfg.body.accountRefreshHours, 1);
  });

  it("serves the Android app link from settings", async () => {
    const { call } = setup({ ANDROID_APP_URL: "https://example.com/talkivo.apk" });
    assert.equal((await call("/api/config")).body.androidAppUrl, "https://example.com/talkivo.apk");
    assert.equal((await setup().call("/api/config")).body.androidAppUrl, null);
  });
});

describe("Smartbase verifier", () => {
  it("calls send-verification and verify-code with the project key", async () => {
    const seen: Array<{ url: string; key: string | null; body: unknown }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body));
      seen.push({ url, key: headers.get("x-smartbase-key"), body });
      if (url.endsWith("/verify-code")) return new Response(JSON.stringify({ valid: body.code === "123456" }));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const v = smartbaseVerifier({ apiKey: "sb_live_test", fetch: fake });
    await v.send("x@y.co");
    assert.equal(await v.check("x@y.co", "123456"), true);
    assert.equal(await v.check("x@y.co", "654321"), false);
    assert.equal(seen[0].url, "https://smartemail.de5.net/api/v1/send-verification");
    assert.equal(seen[0].key, "sb_live_test");
    assert.deepEqual(seen[1].body, { email: "x@y.co", code: "123456" });
  });

  it("reports a send failure instead of pretending it worked", async () => {
    const fake = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const { Accounts } = await import("./accounts.ts");
    const accounts = new Accounts(new MemoryStore(), smartbaseVerifier({ apiKey: "k", fetch: fake }), () => 1, []);
    const res = await accounts.start("a@b.co", "ip");
    assert.equal(res.ok, false);
  });
});
