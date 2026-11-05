/**
 * Stranger lobby engine. Plain TypeScript, no dependencies, so the exact same
 * code runs in the Node/Termux server and inside a Cloudflare Durable Object.
 *
 * Two kinds of room:
 *   duo    two strangers, ends as soon as one leaves.
 *   group  up to GROUP_MAX people. Stays open for newcomers until full, and
 *          lives on as long as someone is still in it.
 *
 * State is in memory: one process (or one Durable Object) is the whole lobby.
 * Clients poll over plain HTTP, so there are no sockets to keep alive.
 */
import { isCountry } from "./countries.ts";
import { freshRec, refreshRec, remainingMs, usageInfo, type UsageRec, type Who } from "./quota.ts";
import {
  GROUP_MAX,
  type ChatMode,
  type LobbyStats,
  type Member,
  type PollOk,
  type RoomKind,
  type WireMessage,
  type WireSignal,
} from "./protocol.ts";

const ALIVE_MS = 12_000; // a peer that has not polled for this long is "gone"
const DROP_MS = 25_000; // ...and is forgotten after this long
const ONLINE_MS = 20_000;
const STRICT_MS = 6_000; // how long to insist on a shared interest
const ENDED_KEEP_MS = 120_000;
const SIGNAL_KEEP_MS = 120_000;
const TYPING_MS = 2_200;
const RATE_WINDOW_MS = 8_000;
const RATE_MAX = 8;
const KEEP_MESSAGES = 200; // per room
const MAX_TEXT = 400;
const MAX_SIGNAL_JSON = 32_000;
const HOLD_MS = 25_000; // how long a long-poll waits for news before answering "nothing yet"
const METER_CAP_MS = 40_000; // the most time one gap between requests can add to someone's used time

type Status = "waiting" | "chatting" | "idle";

type Peer = {
  id: string;
  secret: string;
  nick: string;
  country: string;
  interests: string[];
  mode: ChatMode;
  group: boolean;
  status: Status;
  roomId: string | null;
  /** When this peer entered the queue (oldest waits first). */
  created: number;
  seen: number;
  typingUntil: number;
  /** Messages with an id at or below this were sent before you arrived. */
  msgFloor: number;
  /** A group room you just left — don't bounce straight back into it. */
  avoid: string | null;
  sent: number[];
  /** Who this is, for chat-time limits. Unset = unmetered (the engine on its own). */
  who?: Who;
  /** Their allowance ran out while they were chatting. */
  limited: boolean;
};

type Room = {
  id: string;
  mode: ChatMode;
  kind: RoomKind;
  cap: number;
  members: Set<string>;
  created: number;
  ended: number; // 0 while open
};

type StoredMessage = WireMessage & { roomId: string };
type StoredSignal = WireSignal & { roomId: string; to: string; at: number };

export type EngineResponse = { status: number; body: PollOk | { ok: false; error: string } };

const ID = /^[a-zA-Z0-9_-]{8,64}$/;

function fail(status: number, error: string): EngineResponse {
  return { status, body: { ok: false, error } };
}

function ok(body: PollOk): EngineResponse {
  return { status: 200, body };
}

function cleanNick(raw: unknown): string {
  const nick = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 20);
  return nick || "Stranger";
}

function cleanInterests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const t = String(item ?? "")
      .replace(/[^\p{L}\p{N} '+.&-]/gu, "")
      .trim()
      .slice(0, 24);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function cleanCountry(raw: unknown): string {
  const value = String(raw ?? "").trim();
  return isCountry(value) ? value : "Somewhere else";
}

function cleanMode(raw: unknown): ChatMode {
  return raw === "voice" || raw === "video" ? raw : "text";
}

function int(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1_000_000_000) : 0;
}

function shares(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const mine = new Set(a.map((t) => t.toLowerCase()));
  return b.some((t) => mine.has(t.toLowerCase()));
}

export class LobbyEngine {
  private peers = new Map<string, Peer>();
  private rooms = new Map<string, Room>();
  private messages: StoredMessage[] = [];
  private signals: StoredSignal[] = [];
  private msgId = 1;
  private sigId = 1;
  private roomSeq = 0;
  /** Peers with a held (long-poll) request. Calling one answers that request now. */
  private wakers = new Map<string, () => void>();
  /** Chat time used, by Who.key. Seeded from storage by the platform, saved back when dirty. */
  private usage = new Map<string, UsageRec>();
  private dirtyUsage = new Set<string>();
  private urgentUsage = new Set<string>();
  private lastMeter = 0;

  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  // ---- public ---------------------------------------------------------------

  handle(raw: unknown, who?: Who): EngineResponse {
    const now = this.clock();
    if (!raw || typeof raw !== "object") return fail(400, "Check your details and try again.");
    const body = raw as Record<string, unknown>;
    const peerId = body.peerId;
    const secret = body.secret;
    if (typeof peerId !== "string" || !ID.test(peerId) || typeof secret !== "string" || !ID.test(secret)) {
      return fail(400, "Check your details and try again.");
    }

    const known = this.peers.get(peerId);
    const self = known && known.secret === secret ? known : undefined;
    // The caller is clearly here: count this request before judging who is gone,
    // so a briefly throttled tab isn't evicted by its own late poll.
    if (self) {
      self.seen = now;
      if (who) self.who = who;
    }
    this.prune(now);
    this.meter(now);

    switch (body.op) {
      case "stop":
      case "next": {
        if (!self) return ok({ ok: true, phase: "idle", online: this.onlineCount(now) });
        return ok(this.leave(self, body.op, now));
      }

      case "send": {
        const room = self && self.status === "chatting" && self.roomId ? this.rooms.get(self.roomId) : undefined;
        if (!self || !room) return fail(409, "You are not in a chat.");
        const text = String(body.text ?? "")
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f]/g, "")
          .trim();
        if (!text) return fail(400, "Empty message.");
        self.sent = self.sent.filter((t) => now - t < RATE_WINDOW_MS);
        if (self.sent.length >= RATE_MAX) return fail(429, "Slow down a little.");
        self.sent.push(now);
        self.seen = now;
        self.typingUntil = 0;
        this.messages.push({
          id: this.msgId++,
          roomId: room.id,
          from: self.id,
          nick: self.nick,
          body: text.slice(0, MAX_TEXT),
          at: now,
        });
        this.trimMessages(room.id);
        this.wakeRoom(room, self.id);
        return ok({ ok: true, phase: "idle", online: 0 });
      }

      case "signal": {
        const room = self && self.status === "chatting" && self.roomId ? this.rooms.get(self.roomId) : undefined;
        if (!self || !room || room.ended) return fail(409, "No call to signal.");
        const kind = body.kind;
        if (kind !== "offer" && kind !== "answer" && kind !== "ice") return fail(400, "Unknown signal.");
        let size = 0;
        try {
          size = JSON.stringify(body.payload ?? null).length;
        } catch {
          size = Infinity;
        }
        if (body.payload === undefined || size > MAX_SIGNAL_JSON) return fail(400, "Signal too large.");
        // Duo rooms may omit `to`; group rooms must say who it is for.
        let to = typeof body.to === "string" ? body.to : "";
        if (!to && room.kind === "duo") to = [...room.members].find((id) => id !== self.id) ?? "";
        if (!to || to === self.id || !room.members.has(to)) return fail(409, "That person is not in your room.");
        self.seen = now;
        this.signals.push({
          id: this.sigId++,
          roomId: room.id,
          to,
          from: self.id,
          kind,
          payload: body.payload,
          at: now,
        });
        this.wake([to]);
        return ok({ ok: true, phase: "idle", online: 0 });
      }

      case "typing": {
        const room = self && self.status === "chatting" && self.roomId ? this.rooms.get(self.roomId) : undefined;
        if (!self || !room || room.ended) return ok({ ok: true, phase: "idle", online: 0 });
        if (body.typing === true) {
          // Already marked as typing a moment ago: nothing new to tell anyone.
          if (self.typingUntil - now > TYPING_MS - 800) return ok({ ok: true, phase: "idle", online: 0 });
          self.typingUntil = now + TYPING_MS;
          // Typing fades on its own, so tell the room again when it does.
          const timer = setTimeout(() => this.wakeRoom(room, self.id), TYPING_MS + 60) as unknown as { unref?: () => void };
          timer.unref?.();
        } else {
          if (self.typingUntil === 0) return ok({ ok: true, phase: "idle", online: 0 });
          self.typingUntil = 0;
        }
        this.wakeRoom(room, self.id);
        return ok({ ok: true, phase: "idle", online: 0 });
      }

      case "poll":
        return this.poll(body, self, peerId, secret, !!known, now, who);

      default:
        return fail(400, "Unknown request.");
    }
  }

  stats(): LobbyStats {
    const now = this.clock();
    this.touchHeld(now);
    let waiting = 0;
    let online = 0;
    const places = new Map<string, number>();
    for (const peer of this.peers.values()) {
      if (now - peer.seen > ONLINE_MS) continue;
      online += 1;
      if (peer.status === "waiting") waiting += 1;
      places.set(peer.country, (places.get(peer.country) ?? 0) + 1);
    }
    return {
      ok: true,
      online,
      waiting,
      countries: places.size,
      places: [...places.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([country, n]) => ({ country, n })),
    };
  }

  // ---- long polling ---------------------------------------------------------

  /**
   * Same as `handle`, but a poll that sets `hold: true` and has nothing new to
   * report waits (up to HOLD_MS) until something happens for that person, then
   * answers. A quiet chat costs a couple of requests a minute instead of sixty,
   * and messages still arrive the moment they are sent.
   */
  async handleAsync(
    raw: unknown,
    opts: { holdMs?: number; signal?: AbortSignal; who?: Who } = {},
  ): Promise<EngineResponse> {
    const first = this.handle(raw, opts.who);
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!body || body.op !== "poll" || body.hold !== true || first.status !== 200) return first;
    if (!this.nothingNew(first.body, body)) return first;

    const peerId = body.peerId as string;
    let holdMs = opts.holdMs ?? HOLD_MS;
    const waiting = this.peers.get(peerId);
    if (first.body.ok && first.body.phase === "waiting" && waiting && waiting.interests.length > 0) {
      // After a few seconds a picky searcher accepts anyone: come back then.
      const left = STRICT_MS - (this.clock() - waiting.created);
      if (left > 0) holdMs = Math.min(holdMs, left + 50);
    }
    // Someone in a chat with limited time is answered the moment it runs out.
    const holder = this.peers.get(peerId);
    if (holder && holder.status === "chatting") {
      const left = this.remainingFor(holder, this.clock());
      if (Number.isFinite(left)) holdMs = Math.min(holdMs, left + 50);
    }
    if (opts.signal?.aborted) return first;

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.wakers.get(peerId) === finish) this.wakers.delete(peerId);
        opts.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, holdMs);
      this.wakers.get(peerId)?.(); // a newer poll replaces an older held one
      this.wakers.set(peerId, finish);
      opts.signal?.addEventListener("abort", finish, { once: true });
    });
    if (opts.signal?.aborted) return first;
    return this.handle(raw, opts.who);
  }

  private nothingNew(result: EngineResponse["body"], body: Record<string, unknown>): boolean {
    if (!result.ok) return false;
    if (result.phase === "waiting") return true;
    if (result.phase === "chat") {
      return result.messages.length === 0 && result.signals.length === 0 && body.state === result.state;
    }
    return false;
  }

  private wake(ids: Iterable<string>) {
    for (const id of ids) this.wakers.get(id)?.();
  }

  /** Answer the held requests of everyone in a room (except, optionally, one person). */
  private wakeRoom(room: Room, except?: string) {
    for (const id of room.members) if (id !== except) this.wakers.get(id)?.();
  }

  // ---- polling --------------------------------------------------------------

  private poll(
    body: Record<string, unknown>,
    self: Peer | undefined,
    peerId: string,
    secret: string,
    exists: boolean,
    now: number,
    who?: Who,
  ): EngineResponse {
    const sinceMsg = int(body.sinceMsg);
    const sinceSig = int(body.sinceSig);

    if (body.queue !== true) {
      if (self && self.status === "chatting") {
        self.seen = now;
        return ok(this.snapshot(self, sinceMsg, sinceSig, now));
      }
      if (self && self.limited && self.who) return ok(this.limitReply(self.who, now));
      if (self && self.status === "idle") {
        return ok({ ok: true, phase: "ended", reason: "partner_left", online: this.onlineCount(now), messages: [] });
      }
      // Unknown to us (server restarted, or long idle): tell the client so it
      // doesn't sit in a dead chat forever.
      return ok({ ok: true, phase: "idle", online: this.onlineCount(now) });
    }

    if (exists && !self) return fail(401, "Session expired. Reload and try again.");

    // Out of chat time? Don't start a search; say so (and when it comes back).
    if (who && remainingMs(this.recFor(who, now), who) <= 0) {
      if (self && self.status !== "chatting") self.limited = true;
      return ok(this.limitReply(who, now));
    }

    let peer = self;
    if (!peer) {
      peer = {
        id: peerId,
        secret,
        nick: "Stranger",
        country: "Somewhere else",
        interests: [],
        mode: "text",
        group: false,
        status: "waiting",
        roomId: null,
        created: now,
        seen: now,
        typingUntil: 0,
        msgFloor: 0,
        avoid: null,
        sent: [],
        limited: false,
      };
      this.peers.set(peerId, peer);
    }
    peer.seen = now;
    if (who) peer.who = who;
    peer.limited = false;
    if (peer.status !== "chatting") {
      peer.nick = cleanNick(body.nick);
      peer.country = cleanCountry(body.country);
      peer.interests = cleanInterests(body.interests);
      peer.mode = cleanMode(body.mode);
      peer.group = body.group === true;
      if (peer.status === "idle") {
        peer.created = now;
        peer.avoid = null;
      }
      peer.status = "waiting";
    }

    const seated = peer.status === "chatting" || this.claim(peer, now);
    if (seated) return ok(this.snapshot(peer, sinceMsg, sinceSig, now));
    return ok({ ok: true, phase: "waiting", online: this.onlineCount(now), waiting: this.waitingCount(now) });
  }

  private snapshot(self: Peer, sinceMsg: number, sinceSig: number, now: number): PollOk {
    const room = self.roomId ? this.rooms.get(self.roomId) : undefined;
    const others = room
      ? [...room.members]
          .filter((id) => id !== self.id)
          .map((id) => this.peers.get(id))
          .filter((p): p is Peer => !!p && this.alive(p, now))
      : [];
    const gone = !room || room.ended > 0 || !room.members.has(self.id) || (room.kind === "duo" && others.length === 0);

    const visible = (m: StoredMessage) => m.roomId === self.roomId && m.id > Math.max(sinceMsg, self.msgFloor);
    const messages = this.messages
      .filter(visible)
      .slice(0, 80)
      .map(({ roomId: _roomId, ...m }) => m);

    if (gone) {
      if (room && room.kind === "duo" && !room.ended) room.ended = now;
      room?.members.delete(self.id);
      self.status = "idle";
      self.roomId = null;
      return { ok: true, phase: "ended", reason: "partner_left", online: this.onlineCount(now), messages };
    }

    const signals = this.signals
      .filter((s) => s.roomId === room.id && s.to === self.id && s.id > sinceSig)
      .slice(0, 100)
      .map(({ roomId: _r, to: _t, at: _a, ...s }) => s);

    const typingIds = others.filter((p) => p.typingUntil > now).map((p) => p.id);
    return {
      ok: true,
      phase: "chat",
      online: this.onlineCount(now),
      roomId: room.id,
      mode: room.mode,
      kind: room.kind,
      capacity: room.cap,
      youId: self.id,
      members: others.map((p) => this.card(p)),
      typing: typingIds,
      state: `${room.id}|${others.map((p) => p.id).join(",")}|${typingIds.join(",")}`,
      messages,
      signals,
      ...(self.who ? { usage: usageInfo(this.recFor(self.who, now), self.who) } : {}),
    };
  }

  // ---- chat-time limits ---------------------------------------------------------

  /** The used-time record for someone, with any due refresh applied. */
  private recFor(who: Who, now: number): UsageRec {
    let rec = this.usage.get(who.key);
    if (!rec) {
      rec = freshRec();
      this.usage.set(who.key, rec);
    }
    if (refreshRec(rec, who, now)) this.markUsage(who.key, true);
    return rec;
  }

  private markUsage(key: string, urgent: boolean) {
    this.dirtyUsage.add(key);
    if (urgent) this.urgentUsage.add(key);
  }

  private limitReply(who: Who, now: number): PollOk {
    return { ok: true, phase: "limit", online: this.onlineCount(now), usage: usageInfo(this.recFor(who, now), who) };
  }

  /** Add the time since the last request to everyone who is in a chat, and cut off anyone who has run out. */
  private meter(now: number) {
    const dt = this.lastMeter === 0 ? 0 : Math.max(0, Math.min(now - this.lastMeter, METER_CAP_MS));
    this.lastMeter = now;
    if (dt === 0) return;
    for (const peer of this.peers.values()) {
      if (!peer.who || peer.status !== "chatting") continue;
      const rec = this.recFor(peer.who, now);
      rec.used += dt;
      this.markUsage(peer.who.key, false);
      if (remainingMs(rec, peer.who) <= 0) {
        if (rec.exhaustedAt === 0) rec.exhaustedAt = now;
        this.markUsage(peer.who.key, true);
        this.cutOff(peer, now);
      }
    }
  }

  /** Someone's allowance ran out mid-chat: take them out of their room. */
  private cutOff(self: Peer, now: number) {
    const room = self.roomId ? this.rooms.get(self.roomId) : undefined;
    this.detach(self, room, now);
    self.status = "idle";
    self.limited = true;
    if (room) this.wakeRoom(room);
    this.wake([self.id]);
    this.wakeSearchers(self.id);
  }

  /** A seat may have opened: let searchers look again instead of waiting out their hold. */
  private wakeSearchers(except: string) {
    for (const [id, p] of this.peers) if (p.status === "waiting" && id !== except) this.wakers.get(id)?.();
  }

  /** Time left for a peer that is in a chat right now (Infinity if unmetered). */
  private remainingFor(peer: Peer, now: number): number {
    return peer.who ? remainingMs(this.recFor(peer.who, now), peer.who) : Infinity;
  }

  /** Make this person's used time known (the platform loads it from storage before their first request). */
  seedUsage(key: string, rec: UsageRec) {
    if (!this.usage.has(key)) this.usage.set(key, { used: rec.used, exhaustedAt: rec.exhaustedAt });
  }

  hasUsage(key: string): boolean {
    return this.usage.has(key);
  }

  /** Records that changed since last asked, so they can be saved. */
  takeDirtyUsage(): Array<{ key: string; rec: UsageRec; urgent: boolean }> {
    const out: Array<{ key: string; rec: UsageRec; urgent: boolean }> = [];
    for (const key of this.dirtyUsage) {
      const rec = this.usage.get(key);
      if (rec) out.push({ key, rec: { ...rec }, urgent: this.urgentUsage.has(key) });
    }
    return out;
  }

  /** Mark saved. Records still being written to stay dirty. */
  clearDirtyUsage(keys: string[]) {
    for (const key of keys) {
      this.dirtyUsage.delete(key);
      this.urgentUsage.delete(key);
    }
  }

  /** A person's current allowance, for the account screen. */
  usageFor(who: Who): ReturnType<typeof usageInfo> {
    return usageInfo(this.recFor(who, this.clock()), who);
  }

  // ---- matching -------------------------------------------------------------

  private claim(self: Peer, now: number): boolean {
    const strict = self.interests.length > 0 && now - self.created < STRICT_MS;
    return self.group ? this.claimGroup(self, now, strict) : this.claimDuo(self, now, strict);
  }

  private claimDuo(self: Peer, now: number, strict: boolean): boolean {
    const candidates = [...this.peers.values()]
      .filter(
        (p) =>
          p.id !== self.id &&
          p.status === "waiting" &&
          !p.group &&
          p.mode === self.mode &&
          this.alive(p, now) &&
          (!strict || shares(self.interests, p.interests)),
      )
      .sort(
        (a, b) =>
          Number(shares(self.interests, b.interests)) - Number(shares(self.interests, a.interests)) ||
          a.created - b.created,
      );
    const other = candidates[0];
    if (!other) return false;
    const room = this.openRoom(self.mode, "duo", 2, now);
    this.seat(room, other);
    this.seat(room, self);
    return true;
  }

  private claimGroup(self: Peer, now: number, strict: boolean): boolean {
    // 1. Join a room that still has a free seat.
    const open = [...this.rooms.values()]
      .filter(
        (r) =>
          r.kind === "group" &&
          !r.ended &&
          r.mode === self.mode &&
          r.id !== self.avoid &&
          this.aliveMembers(r, now).length > 0 &&
          this.aliveMembers(r, now).length < r.cap,
      )
      .map((r) => ({ r, people: this.aliveMembers(r, now) }))
      .filter(({ people }) => !strict || people.some((p) => shares(self.interests, p.interests)))
      .sort(
        (a, b) =>
          Number(b.people.some((p) => shares(self.interests, p.interests))) -
            Number(a.people.some((p) => shares(self.interests, p.interests))) ||
          b.people.length - a.people.length ||
          a.r.created - b.r.created,
      );
    if (open[0]) {
      this.seat(open[0].r, self);
      return true;
    }

    // 2. Otherwise start a room with someone else who is waiting for a group.
    const waiting = [...this.peers.values()]
      .filter(
        (p) =>
          p.id !== self.id &&
          p.status === "waiting" &&
          p.group &&
          p.mode === self.mode &&
          this.alive(p, now) &&
          (!strict || shares(self.interests, p.interests)),
      )
      .sort(
        (a, b) =>
          Number(shares(self.interests, b.interests)) - Number(shares(self.interests, a.interests)) ||
          a.created - b.created,
      );
    const other = waiting[0];
    if (!other) return false;
    const room = this.openRoom(self.mode, "group", GROUP_MAX, now);
    this.seat(room, other);
    this.seat(room, self);
    return true;
  }

  private openRoom(mode: ChatMode, kind: RoomKind, cap: number, now: number): Room {
    this.roomSeq += 1;
    const id = `r${now.toString(36)}${this.roomSeq.toString(36)}${randomToken()}`;
    const room: Room = { id, mode, kind, cap, members: new Set(), created: now, ended: 0 };
    this.rooms.set(id, room);
    return room;
  }

  private seat(room: Room, peer: Peer) {
    room.members.add(peer.id);
    peer.status = "chatting";
    peer.roomId = room.id;
    peer.msgFloor = this.msgId - 1;
    peer.typingUntil = 0;
    peer.avoid = null;
    peer.sent = [];
    this.wakeRoom(room);
  }

  /** Take someone out of their room (duo: the room ends; group: it carries on). Returns the group room to avoid. */
  private detach(self: Peer, room: Room | undefined, now: number): string | null {
    let avoid: string | null = null;
    if (room) {
      room.members.delete(self.id);
      if (room.kind === "duo") {
        room.ended = room.ended || now;
        for (const id of room.members) {
          const other = this.peers.get(id);
          if (other) {
            other.status = "idle";
            other.roomId = null;
          }
          this.wakers.get(id)?.(); // tell the partner right away
        }
        room.members.clear();
      } else {
        avoid = room.id;
        if (room.members.size === 0) room.ended = now;
      }
    }
    self.roomId = null;
    self.typingUntil = 0;
    return avoid;
  }

  private leave(self: Peer, how: "next" | "stop", now: number): PollOk {
    const room = self.roomId ? this.rooms.get(self.roomId) : undefined;
    if (self.who && self.status === "chatting") this.markUsage(self.who.key, true);
    const avoid = this.detach(self, room, now);
    if (room) this.wakeRoom(room);
    this.wake([self.id]); // answer this peer's own held request too
    this.wakeSearchers(self.id);

    if (how === "stop") {
      this.peers.delete(self.id);
      return { ok: true, phase: "idle", online: this.onlineCount(now) };
    }

    if (self.who && remainingMs(this.recFor(self.who, now), self.who) <= 0) {
      self.status = "idle";
      self.limited = true;
      return this.limitReply(self.who, now);
    }
    self.status = "waiting";
    self.created = now;
    self.seen = now;
    self.avoid = avoid;
    if (this.claim(self, now)) return this.snapshot(self, 0, 0, now);
    return { ok: true, phase: "waiting", online: this.onlineCount(now), waiting: this.waitingCount(now) };
  }

  // ---- housekeeping ---------------------------------------------------------

  /** A peer with a held request is here, even though it has been quiet for a while. */
  private touchHeld(now: number) {
    for (const id of this.wakers.keys()) {
      const peer = this.peers.get(id);
      if (peer) peer.seen = now;
    }
  }

  private prune(now: number) {
    this.touchHeld(now);
    for (const [id, peer] of this.peers) {
      if (now - peer.seen > DROP_MS) {
        this.peers.delete(id);
        if (peer.roomId) this.rooms.get(peer.roomId)?.members.delete(id);
      }
    }
    for (const [id, room] of this.rooms) {
      if (!room.ended) {
        let lost = false;
        for (const memberId of [...room.members]) {
          const p = this.peers.get(memberId);
          if (!p || !this.alive(p, now)) {
            room.members.delete(memberId);
            lost = true;
          }
        }
        if (room.kind === "duo" ? room.members.size < 2 : room.members.size === 0) room.ended = now;
        if (lost) this.wakeRoom(room);
      } else if (now - room.ended > ENDED_KEEP_MS) {
        this.rooms.delete(id);
        this.messages = this.messages.filter((m) => m.roomId !== id);
      }
    }
    if (this.signals.length > 0) this.signals = this.signals.filter((s) => now - s.at < SIGNAL_KEEP_MS);
  }

  private trimMessages(roomId: string) {
    let count = 0;
    for (const m of this.messages) if (m.roomId === roomId) count += 1;
    if (count <= KEEP_MESSAGES) return;
    let drop = count - KEEP_MESSAGES;
    this.messages = this.messages.filter((m) => !(m.roomId === roomId && drop-- > 0));
  }

  private alive(p: Peer, now: number) {
    return now - p.seen < ALIVE_MS;
  }

  private aliveMembers(room: Room, now: number): Peer[] {
    const out: Peer[] = [];
    for (const id of room.members) {
      const p = this.peers.get(id);
      if (p && this.alive(p, now)) out.push(p);
    }
    return out;
  }

  private card(p: Peer): Member {
    return { id: p.id, nick: p.nick, country: p.country, interests: p.interests };
  }

  private onlineCount(now: number) {
    let n = 0;
    for (const p of this.peers.values()) if (now - p.seen < ONLINE_MS) n += 1;
    return n;
  }

  private waitingCount(now: number) {
    let n = 0;
    for (const p of this.peers.values()) if (p.status === "waiting" && this.alive(p, now)) n += 1;
    return n;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
}
