import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LobbyEngine } from "./engine.ts";
import type { PollChat, PollOk } from "./protocol.ts";

type Opts = { nick?: string; mode?: "text" | "voice" | "video"; group?: boolean; interests?: string[]; country?: string };

let n = 0;
function setup() {
  let t = 1_000_000;
  const engine = new LobbyEngine(() => t);
  const advance = (ms: number) => {
    t += ms;
  };
  function user(opts: Opts = {}) {
    n += 1;
    const peerId = `peer${String(n).padStart(6, "0")}`;
    const secret = `secret${String(n).padStart(6, "0")}`;
    const base = { peerId, secret };
    let sinceMsg = 0;
    let sinceSig = 0;
    let lastState = "";
    const call = (body: Record<string, unknown>) => engine.handle({ ...base, ...body });
    const api = {
      id: peerId,
      call,
      join: () =>
        call({
          op: "poll",
          queue: true,
          nick: opts.nick ?? "N",
          mode: opts.mode ?? "text",
          group: opts.group ?? false,
          interests: opts.interests ?? [],
          country: opts.country ?? "Kenya",
        }).body as PollOk,
      typing: (on: boolean) => call({ op: "typing", typing: on }),
      /** A held poll, as the app sends it. Resolves when the server answers. */
      hold: async (holdMs = 400) => {
        const r = (await engine.handleAsync(
          { ...base, op: "poll", queue: false, hold: true, sinceMsg, sinceSig, state: lastState },
          { holdMs },
        )).body as PollOk;
        if (r.ok && r.phase === "chat") {
          for (const m of r.messages) sinceMsg = Math.max(sinceMsg, m.id);
          for (const sg of r.signals) sinceSig = Math.max(sinceSig, sg.id);
          lastState = r.state;
        }
        return r;
      },
      poll: () => {
        const r = call({ op: "poll", queue: false, sinceMsg, sinceSig }).body as PollOk;
        if (r.ok && r.phase === "chat") {
          for (const m of r.messages) sinceMsg = Math.max(sinceMsg, m.id);
          for (const s of r.signals) sinceSig = Math.max(sinceSig, s.id);
        }
        return r;
      },
      send: (text: string) => call({ op: "send", text }),
      signal: (to: string | undefined, kind = "offer", payload: unknown = { sdp: "x" }) =>
        call({ op: "signal", to, kind, payload }),
      next: () => call({ op: "next" }).body as PollOk,
      stop: () => call({ op: "stop" }).body as PollOk,
    };
    return api;
  }
  return { engine, advance, user };
}

const phase = (r: PollOk) => (r.ok ? r.phase : "error");

const chat = (r: PollOk) => {
  assert.equal(r.ok && r.phase, "chat", `expected chat, got ${JSON.stringify(r)}`);
  return r as PollChat;
};

describe("duo rooms", () => {
  it("pairs two strangers with the same mode", () => {
    const { user } = setup();
    const a = user();
    const b = user();
    const first = a.join();
    assert.equal(first.ok && first.phase, "waiting");
    const second = chat(b.join());
    assert.equal(second.kind, "duo");
    assert.equal(second.capacity, 2);
    assert.equal(second.members.length, 1);
    assert.equal(second.members[0].id, a.id);
    assert.equal(chat(a.poll()).members[0].id, b.id);
  });

  it("never mixes modes, or duo with group", () => {
    const { user } = setup();
    const a = user({ mode: "text" });
    const b = user({ mode: "video" });
    const c = user({ mode: "text", group: true });
    a.join();
    assert.equal(phase(b.join()), "waiting");
    assert.equal(phase(c.join()), "waiting");
  });

  it("relays chat only to the partner and ends when one leaves", () => {
    const { user } = setup();
    const a = user();
    const b = user();
    const c = user();
    a.join();
    b.join();
    c.join();
    assert.equal(a.send("hello").status, 200);
    const got = chat(b.poll());
    assert.deepEqual(
      got.messages.map((m) => m.body),
      ["hello"],
    );
    assert.notEqual(phase(c.poll()), "chat", "a third stranger must not see their messages");
    b.next();
    const ended = a.poll();
    assert.equal(ended.ok && ended.phase, "ended");
  });

  it("routes signals to the partner without needing `to`", () => {
    const { user } = setup();
    const a = user({ mode: "video" });
    const b = user({ mode: "video" });
    a.join();
    b.join();
    assert.equal(a.signal(undefined, "offer").status, 200);
    const got = chat(b.poll());
    assert.equal(got.signals.length, 1);
    assert.equal(got.signals[0].from, a.id);
    assert.equal(got.signals[0].kind, "offer");
    assert.equal(chat(a.poll()).signals.length, 0);
  });

  it("prefers a shared interest, then falls back after a few seconds", () => {
    const { user, advance } = setup();
    const music = user({ interests: ["Music"] });
    const chess = user({ interests: ["Chess"] });
    const mate = user({ interests: ["music"] });
    music.join();
    assert.equal(phase(chess.join()), "waiting");
    assert.equal(chat(mate.join()).members[0].id, music.id);
    advance(7_000);
    chess.poll();
    const late = user({ interests: ["Chess"] });
    assert.equal(chat(late.join()).members[0].id, chess.id);
  });

  it("rate limits chat spam and trims long lines", () => {
    const { user } = setup();
    const a = user();
    const b = user();
    a.join();
    b.join();
    let last = 200;
    for (let i = 0; i < 12; i += 1) last = a.send("x").status;
    assert.equal(last, 429);
    b.send("y".repeat(900));
    const got = chat(a.poll());
    assert.equal(got.messages.at(-1)?.body.length, 400);
  });

  it("tells a client the server forgot it instead of leaving it hanging", () => {
    const { user } = setup();
    const ghost = user();
    const r = ghost.poll();
    assert.equal(r.ok && r.phase, "idle");
  });
});

describe("group rooms", () => {
  it("starts a room for two and fills up to four, then opens a new room", () => {
    const { user } = setup();
    const people = Array.from({ length: 6 }, (_, i) => user({ group: true, nick: `P${i}` }));
    assert.equal(phase(people[0].join()), "waiting");
    const second = chat(people[1].join());
    assert.equal(second.kind, "group");
    assert.equal(second.capacity, 4);
    const third = chat(people[2].join());
    assert.equal(third.members.length, 2);
    const fourth = chat(people[3].join());
    assert.equal(fourth.members.length, 3);
    // room is full: the fifth person waits...
    assert.equal(phase(people[4].join()), "waiting");
    // ...and the sixth starts a second room with them
    const sixth = chat(people[5].join());
    assert.equal(sixth.members.length, 1);
    assert.equal(sixth.members[0].id, people[4].id);
    // first room never exceeded 4
    assert.equal(chat(people[0].poll()).members.length, 3);
  });

  it("shows a message to everyone in the room, with the sender's name", () => {
    const { user } = setup();
    const [a, b, c] = [user({ group: true, nick: "Ann" }), user({ group: true, nick: "Bo" }), user({ group: true, nick: "Cy" })];
    a.join();
    b.join();
    c.join();
    a.send("hi all");
    for (const who of [b, c]) {
      const got = chat(who.poll());
      assert.equal(got.messages[0].body, "hi all");
      assert.equal(got.messages[0].nick, "Ann");
      assert.equal(got.messages[0].from, a.id);
    }
  });

  it("does not show old messages to someone who joins later", () => {
    const { user } = setup();
    const [a, b, late] = [user({ group: true }), user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    a.send("secret before you came");
    const joined = chat(late.join());
    assert.equal(joined.messages.length, 0);
    a.send("after");
    assert.deepEqual(
      chat(late.poll()).messages.map((m) => m.body),
      ["after"],
    );
  });

  it("routes signals only to the addressed member and refuses outsiders", () => {
    const { user } = setup();
    const [a, b, c] = [user({ group: true, mode: "video" }), user({ group: true, mode: "video" }), user({ group: true, mode: "video" })];
    const outsider = user({ mode: "video" });
    a.join();
    b.join();
    c.join();
    assert.equal(a.signal(b.id, "offer").status, 200);
    assert.equal(chat(b.poll()).signals.length, 1);
    assert.equal(chat(c.poll()).signals.length, 0);
    assert.equal(a.signal(undefined, "offer").status, 409, "group signals must name a recipient");
    assert.equal(a.signal(outsider.id, "offer").status, 409);
    assert.equal(a.signal(a.id, "offer").status, 409);
  });

  it("keeps the room alive when someone leaves, and lets a newcomer take the seat", () => {
    const { user } = setup();
    const [a, b, c] = [user({ group: true }), user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    c.join();
    c.stop();
    const left = chat(a.poll());
    assert.equal(left.members.length, 1);
    const d = user({ group: true });
    const joined = chat(d.join());
    assert.equal(joined.members.length, 2);
    assert.equal(chat(a.poll()).members.length, 2);
  });

  it("Next leaves the room and doesn't bounce straight back in", () => {
    const { user } = setup();
    const [a, b, c] = [user({ group: true }), user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    c.join();
    assert.equal(phase(c.next()), "waiting");
    assert.equal(chat(a.poll()).members.length, 1);
    // the only open room is the one c just left, so c keeps waiting
    assert.equal(phase(c.join()), "waiting");
    // newcomers take the free seats instead
    const [d, e, f] = [user({ group: true }), user({ group: true }), user({ group: true })];
    assert.equal(chat(d.join()).members.length, 2);
    assert.equal(phase(c.join()), "waiting");
    assert.equal(chat(e.join()).members.length, 3); // room is now full: a, b, d, e
    // the next newcomer finds the room full and teams up with c instead
    const fresh = chat(f.join());
    assert.deepEqual(
      fresh.members.map((m) => m.id),
      [c.id],
    );
  });

  it("a lone survivor stays in the room instead of being kicked out", () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    b.stop();
    const r = chat(a.poll());
    assert.equal(r.members.length, 0);
    const newcomer = user({ group: true });
    assert.equal(chat(newcomer.join()).members[0].id, a.id);
  });

  it("drops people who stop polling and frees their seat", () => {
    const { user, advance } = setup();
    const [a, b, c] = [user({ group: true }), user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    c.join();
    for (let i = 0; i < 3; i += 1) {
      advance(5_000);
      a.poll();
      b.poll();
    }
    const r = chat(a.poll());
    assert.equal(r.members.length, 1, "c went silent and should be gone");
    assert.equal(r.members[0].id, b.id);
  });

  it("doesn't evict someone just because their own poll was late", () => {
    const { user, advance } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    advance(14_000);
    assert.equal(phase(a.poll()), "chat");
  });

  it("reports who is typing", () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    a.typing(true);
    assert.deepEqual(chat(b.poll()).typing, [a.id]);
    a.typing(false);
    assert.deepEqual(chat(b.poll()).typing, []);
  });
});

describe("long polling", () => {
  const msFrom = async (fn: () => Promise<unknown>) => {
    const t = Date.now();
    await fn();
    return Date.now() - t;
  };
  const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  it("holds a quiet poll, then answers the moment a message arrives", async () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    await a.hold(50); // learn the room state
    const pending = a.hold(3000);
    await tick();
    b.send("hi there");
    const t0 = Date.now();
    const r = chat(await pending);
    assert.ok(Date.now() - t0 < 500, "should answer immediately, not after the hold");
    assert.equal(r.messages[0].body, "hi there");
  });

  it("answers after the hold time when nothing happens", async () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    await a.hold(50);
    const ms = await msFrom(() => a.hold(300));
    assert.ok(ms >= 250, `expected to wait ~300ms, waited ${ms}`);
  });

  it("wakes a searcher the moment a partner is found", async () => {
    const { engine, user } = setup();
    const [a, b] = [user(), user()];
    a.join();
    const secretOf = (id: string) => `secret${id.slice(4)}`;
    const pending = engine.handleAsync(
      { op: "poll", peerId: a.id, secret: secretOf(a.id), queue: true, mode: "text", hold: true },
      { holdMs: 3000 },
    );
    await tick();
    b.join();
    const t0 = Date.now();
    const r = chat((await pending).body as PollOk);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(r.members[0].id, b.id);
  });

  it("wakes members when someone joins, leaves, or signals", async () => {
    const { user } = setup();
    const [a, b] = [user({ group: true, mode: "video" }), user({ group: true, mode: "video" })];
    a.join();
    b.join();
    await a.hold(50);

    let pending = a.hold(3000);
    await tick();
    const c = user({ group: true, mode: "video" });
    c.join();
    assert.equal(chat(await pending).members.length, 2, "join wakes the room");

    pending = a.hold(3000);
    await tick();
    b.signal(a.id, "offer");
    assert.equal(chat(await pending).signals.length, 1, "signal wakes the recipient");

    pending = a.hold(3000);
    await tick();
    c.stop();
    assert.equal(chat(await pending).members.length, 1, "leaving wakes the room");
  });

  it("wakes others when someone starts or stops typing", async () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    await a.hold(50);
    let pending = a.hold(3000);
    await tick();
    b.typing(true);
    assert.deepEqual(chat(await pending).typing, [b.id]);
    pending = a.hold(3000);
    await tick();
    b.typing(false);
    assert.deepEqual(chat(await pending).typing, []);
  });

  it("a held request keeps its owner counted as present", async () => {
    const { engine, user, advance } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    await a.hold(50);
    const pending = a.hold(200);
    advance(30_000); // a long quiet spell while the request is held
    assert.equal(engine.stats().online >= 1, true);
    await pending;
    assert.equal(phase(a.poll()), "chat", "a was not evicted while its request was held");
  });

  it("a poll that already has news is answered at once", async () => {
    const { user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    b.send("first");
    const ms = await msFrom(() => a.hold(3000));
    assert.ok(ms < 300, `news should not wait (took ${ms}ms)`);
  });

  it("tells a 1:1 partner right away when the other person leaves", async () => {
    const { user } = setup();
    const [a, b] = [user(), user()];
    a.join();
    b.join();
    await a.hold(50);
    const pending = a.hold(3000);
    await tick();
    const t0 = Date.now();
    b.call({ op: "stop" });
    const r = await pending;
    assert.ok(Date.now() - t0 < 500, "should not wait out the hold");
    assert.equal(r.ok && r.phase, "ended");
  });

  it("wakes someone waiting for a full group when a seat frees up", async () => {
    const { engine, user } = setup();
    const us = [0, 1, 2, 3].map(() => user({ group: true }));
    for (const u of us) u.join();
    const e = user({ group: true });
    e.join();
    const secretOf = (id: string) => `secret${id.slice(4)}`;
    const pending = engine.handleAsync(
      { op: "poll", peerId: e.id, secret: secretOf(e.id), queue: true, mode: "text", group: true, hold: true },
      { holdMs: 3000 },
    );
    await tick();
    const t0 = Date.now();
    us[3].call({ op: "stop" });
    const r = chat((await pending).body as PollOk);
    assert.ok(Date.now() - t0 < 500, "should take the seat at once");
    assert.equal(r.members.length, 3);
  });

  it("stops waiting when the client hangs up", async () => {
    const { engine, user } = setup();
    const [a, b] = [user({ group: true }), user({ group: true })];
    a.join();
    b.join();
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = engine.handleAsync(
      { op: "poll", peerId: a.id, secret: `secret${a.id.slice(4)}`, queue: false, hold: true, state: chat(a.poll()).state },
      { holdMs: 5000, signal: ctl.signal },
    );
    await tick();
    ctl.abort();
    await p;
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe("input safety", () => {
  it("rejects malformed requests without throwing", () => {
    const { engine } = setup();
    for (const raw of [null, undefined, 5, "x", {}, { op: "poll" }, { op: "poll", peerId: "short", secret: "short" }]) {
      assert.equal(engine.handle(raw).status, 400);
    }
  });

  it("refuses a wrong secret", () => {
    const { engine, user } = setup();
    const a = user();
    a.join();
    const r = engine.handle({ op: "poll", queue: true, peerId: a.id, secret: "wrongsecret1" });
    assert.equal(r.status, 401);
  });

  it("clamps profile fields", () => {
    const { user } = setup();
    const a = user({ nick: "x".repeat(80), interests: new Array(20).fill(0).map((_, i) => `tag${i}`), country: "Atlantis" });
    const b = user();
    a.join();
    const r = chat(b.join());
    assert.equal(r.members[0].nick.length, 20);
    assert.equal(r.members[0].interests.length, 8);
    assert.equal(r.members[0].country, "Somewhere else");
  });

  it("counts people online", () => {
    const { engine, user } = setup();
    user({ mode: "text" }).join();
    user({ mode: "video", country: "Ghana" }).join();
    const stats = engine.stats();
    assert.equal(stats.online, 2);
    assert.equal(stats.waiting, 2);
    assert.equal(stats.countries, 2);
  });
});
