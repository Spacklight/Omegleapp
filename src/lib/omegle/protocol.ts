export type ChatMode = "text" | "voice" | "video";

/** One-to-one, or a room of up to GROUP_MAX people (you included). */
export type RoomKind = "duo" | "group";

export const GROUP_MAX = 4;

export type LobbyCountry = { country: string; n: number };

/** Another person in your room. */
export type Member = {
  id: string;
  nick: string;
  country: string;
  interests: string[];
};

export type ChatLine = {
  id: number;
  from: "you" | "them" | "system";
  body: string;
  at: number;
  /** Who said it — shown in group rooms. */
  nick?: string;
};

export type WireMessage = {
  id: number;
  from: string;
  nick: string;
  body: string;
  at: number;
};

export type WireSignal = {
  id: number;
  from: string;
  kind: "offer" | "answer" | "ice";
  payload: unknown;
};

export type LobbyStats = {
  ok: true;
  online: number;
  waiting: number;
  countries: number;
  places: LobbyCountry[];
};

/** How much chat time someone has, as shown in the app. */
export type UsageInfo = {
  /** "guest" = no account (one allowance, never refreshes); "account" = signed in. */
  kind: "guest" | "account";
  allowMs: number;
  usedMs: number;
  remainingMs: number;
  /** When a used-up allowance comes back (epoch ms). null = never (guests) or not used up. */
  resetAt: number | null;
  /** Whether the allowance ever refreshes. */
  refreshes: boolean;
  /** How long after running out it comes back (null = never). */
  refreshMs: number | null;
};

export type PollWaiting = {
  ok: true;
  phase: "waiting";
  online: number;
  waiting: number;
};

export type PollChat = {
  ok: true;
  phase: "chat";
  online: number;
  roomId: string;
  mode: ChatMode;
  kind: RoomKind;
  capacity: number;
  youId: string;
  /** Everyone else in the room right now (0 to 3). */
  members: Member[];
  /** Ids of members who are typing. */
  typing: string[];
  /** Fingerprint of who is here and who is typing. Send it back with the next poll so the server can hold the request until something changes. */
  state: string;
  messages: WireMessage[];
  signals: WireSignal[];
  /** Chat time left (only when the server is metering this person). */
  usage?: UsageInfo;
};

export type PollEnded = {
  ok: true;
  phase: "ended";
  reason: "partner_left" | "skipped" | "reset";
  online: number;
  messages: WireMessage[];
};

export type PollIdle = { ok: true; phase: "idle"; online: number };

/** The chat allowance is used up. */
export type PollLimit = { ok: true; phase: "limit"; online: number; usage: UsageInfo };

export type PollOk = PollWaiting | PollChat | PollEnded | PollIdle | PollLimit;

export type ApiFail = { ok: false; error: string };
