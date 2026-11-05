import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Globe,
  MessageSquare,
  Mic,
  MicOff,
  Music,
  Pause,
  Play,
  Radio,
  Repeat,
  Send,
  Shield,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
  User,
  UserRound,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { previewPathPrefix } from "@/lib/preview-path-prefix";
import { COUNTRIES, countryFromTimeZone } from "@/lib/omegle/countries";
import {
  GROUP_MAX,
  type ChatLine,
  type ChatMode,
  type LobbyStats,
  type PollChat,
  type PollOk,
  type UsageInfo,
} from "@/lib/omegle/protocol";
import { MeshCall, openMic, type PeerMedia, type SignalKind } from "./call";
import { Mixer, type MixerState } from "./mixer";
import { apiPath, authHeaders, clock, useConfig, useMe, waitText } from "./account";
import { AuthPanel } from "./auth-panel";
import { InstallBanner } from "./install-banner";
import { ThemeToggle, useTheme } from "./theme-toggle";

const SUGGESTIONS = [
  "Music",
  "Movies",
  "Football",
  "Gaming",
  "Food",
  "Travel",
  "Books",
  "Anime",
  "Languages",
  "Coding",
];

const ADULT_KEY = "omegle-adult";
const PROFILE_KEY = "omegle-profile";

type Phase = "lobby" | "search" | "chat" | "ended";
type Sheet = null | "safety" | "host" | "music" | "account";

type Identity = { peerId: string; secret: string };

function uid(prefix: string) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function apiUrl() {
  return apiPath("/api/omegle");
}

async function post(body: unknown, signal?: AbortSignal): Promise<PollOk> {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json()) as PollOk | { ok: false; error: string };
  if (!res.ok || !data.ok) {
    throw new Error("error" in data && data.error ? data.error : "The lobby did not answer.");
  }
  return data;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function loadIdentity(): Identity {
  const raw = sessionStorage.getItem("omegle-self");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Identity;
      if (parsed.peerId && parsed.secret) return parsed;
    } catch {
      /* fresh identity */
    }
  }
  const next = { peerId: uid("p"), secret: uid("s") };
  sessionStorage.setItem("omegle-self", JSON.stringify(next));
  return next;
}

function ModeIcon({ mode, className }: { mode: ChatMode; className?: string }) {
  if (mode === "video") return <Video className={className} strokeWidth={1.75} />;
  if (mode === "voice") return <Mic className={className} strokeWidth={1.75} />;
  return <MessageSquare className={className} strokeWidth={1.75} />;
}

export function OmegleApp() {
  const [theme, setTheme] = useTheme();
  const [phase, setPhase] = useState<Phase>("lobby");
  const [mode, setMode] = useState<ChatMode>("text");
  const [group, setGroup] = useState(false);
  const [nick, setNick] = useState("");
  const [country, setCountry] = useState("Somewhere else");
  const [interests, setInterests] = useState<string[]>([]);
  const [draftInterest, setDraftInterest] = useState("");
  const [adult, setAdult] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [stats, setStats] = useState<LobbyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [room, setRoom] = useState<PollChat | null>(null);
  const [endedNote, setEndedNote] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [text, setText] = useState("");
  const [camOff, setCamOff] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [media, setMedia] = useState<Mixer | null>(null);
  const [mixerState, setMixerState] = useState<MixerState | null>(null);
  const [peers, setPeers] = useState<PeerMedia[]>([]);
  const [booted, setBooted] = useState(false);
  const { me, refresh: refreshMe, signOut } = useMe();
  const quota = useConfig();
  // Chat time left, as last told by the server, and the moment we heard it.
  const [usage, setUsage] = useState<{ info: UsageInfo; at: number } | null>(null);
  const [limitInfo, setLimitInfo] = useState<UsageInfo | null>(null);
  const [, setSecond] = useState(0);

  const identity = useRef<Identity | null>(null);
  const mediaRef = useRef<Mixer | null>(null);
  const meshRef = useRef<MeshCall | null>(null);
  const acquiring = useRef(0);
  const sinceMsg = useRef(0);
  const sinceSig = useRef(0);
  const seenEcho = useRef<string[]>([]);
  const greeted = useRef<string | null>(null);
  const knownMembers = useRef<Map<string, string>>(new Map());
  const localId = useRef(-1);
  const epoch = useRef(0);
  const pausePoll = useRef(false);
  const [kick, setKick] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const profileRef = useRef({ mode, group, nick, country, interests });
  profileRef.current = { mode, group, nick, country, interests };
  const roomState = useRef("");
  const lastTyping = useRef(0);

  const localStream = media?.out ?? null;
  const nextLocalId = useCallback(() => {
    localId.current -= 1;
    return localId.current;
  }, []);

  useEffect(() => {
    identity.current = loadIdentity();
    const savedAdult = localStorage.getItem(ADULT_KEY) === "1";
    setAdult(savedAdult);
    let detected = "Somewhere else";
    try {
      detected = countryFromTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      detected = "Somewhere else";
    }
    const saved = localStorage.getItem(PROFILE_KEY);
    let nextMode: ChatMode = "text";
    let nextGroup = false;
    let nextInterests: string[] = [];
    let nextNick = "";
    let nextCountry = detected;
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as {
          mode?: ChatMode;
          group?: boolean;
          nick?: string;
          country?: string;
          interests?: string[];
        };
        if (parsed.mode === "text" || parsed.mode === "voice" || parsed.mode === "video") nextMode = parsed.mode;
        if (parsed.group === true) nextGroup = true;
        if (typeof parsed.nick === "string") nextNick = parsed.nick;
        if (typeof parsed.country === "string") nextCountry = parsed.country;
        if (Array.isArray(parsed.interests)) nextInterests = parsed.interests.slice(0, 8);
      } catch {
        /* ignore broken profile */
      }
    }
    setMode(nextMode);
    setGroup(nextGroup);
    setNick(nextNick);
    setCountry(nextCountry);
    setInterests(nextInterests);
    setBooted(true);
    const params = new URLSearchParams(window.location.search);
    if (params.get("pair") === "1" && savedAdult && nextMode === "text") {
      setPhase("search");
    }
  }, []);

  // Back in the lobby: chat time may have changed.
  useEffect(() => {
    if (booted && phase === "lobby") void refreshMe();
  }, [booted, phase, refreshMe]);

  // Tick once a second while a countdown is on screen.
  useEffect(() => {
    if (phase !== "chat" || !usage) return;
    const id = setInterval(() => setSecond((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [phase, usage]);

  useEffect(() => {
    // The online counter is decoration: check it rarely, and only where it is shown.
    if (!booted || (phase !== "lobby" && phase !== "search")) return;
    let stop = false;
    const pull = async () => {
      if (document.hidden) return;
      try {
        const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
        const res = await fetch(`${prefix}/api/omegle`);
        if (!res.ok) return;
        const data = (await res.json()) as LobbyStats;
        if (!stop && data.ok) setStats(data);
      } catch {
        /* lobby count is decorative */
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 30_000);
    const onVisible = () => void pull();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [booted, phase]);

  // Release the mic, camera and calls if the page goes away.
  useEffect(
    () => () => {
      meshRef.current?.close();
      mediaRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    if (!media) {
      setMixerState(null);
      return;
    }
    setMixerState(media.state);
    return media.subscribe(setMixerState);
  }, [media]);

  const closeCall = useCallback(() => {
    meshRef.current?.close();
    meshRef.current = null;
    setPeers([]);
  }, []);

  /** Stop the mic/camera/music and any calls. */
  const releaseMedia = useCallback(() => {
    acquiring.current += 1;
    closeCall();
    mediaRef.current?.stop();
    mediaRef.current = null;
    setMedia(null);
    setCamOff(false);
  }, [closeCall]);

  /** Open the mic (and camera) for a mode and wrap it in the mixer. */
  const acquire = useCallback(
    async (nextMode: ChatMode, nextGroup: boolean): Promise<boolean> => {
      releaseMedia();
      if (nextMode === "text") return true;
      const ticket = acquiring.current;
      const raw = await openMic(nextMode === "video", nextGroup);
      if (ticket !== acquiring.current) {
        raw.getTracks().forEach((track) => track.stop());
        return false;
      }
      const mixer = new Mixer(raw);
      mediaRef.current = mixer;
      setMedia(mixer);
      return true;
    },
    [releaseMedia],
  );

  const pushSignal = useCallback((to: string, kind: SignalKind, payload: unknown) => {
    const who = identity.current;
    if (!who) return;
    void post({ op: "signal", peerId: who.peerId, secret: who.secret, to, kind, payload }).catch(() => {});
  }, []);

  /** Keep one call open per person in the room, and feed them their signals. */
  const syncCalls = useCallback(
    (data: PollChat) => {
      const who = identity.current;
      const local = mediaRef.current?.out;
      if (!who || !local || data.mode === "text") return;
      let mesh = meshRef.current;
      if (!mesh) {
        mesh = new MeshCall(who.peerId, local, pushSignal, () => setPeers(meshRef.current?.peers() ?? []));
        meshRef.current = mesh;
      }
      mesh.sync(data.members.map((member) => member.id));
      for (const sig of data.signals) mesh.take(sig);
    },
    [pushSignal],
  );

  useEffect(() => {
    if (phase !== "search" && phase !== "chat") return;
    const who = identity.current;
    if (!who) return;
    const ctl = new AbortController();
    let stop = false;

    /** Apply one answer from the lobby. Returns true when it carried something new. */
    const apply = (data: PollOk, profile: typeof profileRef.current): boolean => {
      if (data.phase === "waiting") {
        if (phase === "chat") {
          closeCall();
          setEndedNote(null);
          setPhase("ended");
        }
        return false;
      }
      if (data.phase === "ended") {
        closeCall();
        setEndedNote(null);
        setPhase("ended");
        return true;
      }
      if (data.phase === "idle") {
        // The lobby has forgotten us (it restarted, or we were away too long).
        if (phase === "chat") {
          closeCall();
          setEndedNote("The connection to the lobby was reset.");
          setPhase("ended");
        }
        return false;
      }
      if (data.phase === "limit") {
        // Out of chat time: stop everything and say so.
        releaseMedia();
        resetRoomState();
        setUsage({ info: data.usage, at: Date.now() });
        setLimitInfo(data.usage);
        setPhase("lobby");
        return true;
      }
      if (data.phase !== "chat") return false;
      if (data.usage) setUsage({ info: data.usage, at: Date.now() });

      const changed = data.state !== roomState.current;
      roomState.current = data.state;
      setRoom(data);
      const incoming: ChatLine[] = [];
      let freshRoom = false;
      if (greeted.current !== data.roomId) {
        greeted.current = data.roomId;
        freshRoom = true;
        knownMembers.current = new Map(data.members.map((m) => [m.id, m.nick]));
        incoming.push({
          id: nextLocalId(),
          from: "system",
          body: intro(data, profile.interests),
          at: Date.now(),
        });
      } else if (data.kind === "group") {
        const now = new Map(data.members.map((m) => [m.id, m.nick]));
        for (const [id, name] of now) {
          if (!knownMembers.current.has(id)) {
            incoming.push({ id: nextLocalId(), from: "system", body: `${name} joined.`, at: Date.now() });
          }
        }
        for (const [id, name] of knownMembers.current) {
          if (!now.has(id)) {
            incoming.push({ id: nextLocalId(), from: "system", body: `${name} left.`, at: Date.now() });
          }
        }
        knownMembers.current = now;
      }
      for (const message of data.messages) {
        sinceMsg.current = Math.max(sinceMsg.current, message.id);
        const mine = message.from === who.peerId;
        if (mine) {
          const idx = seenEcho.current.indexOf(message.body);
          if (idx >= 0) {
            seenEcho.current.splice(idx, 1);
            continue;
          }
        }
        incoming.push({
          id: message.id,
          from: mine ? "you" : "them",
          body: message.body,
          at: message.at,
          nick: message.nick,
        });
      }
      if (incoming.length > 0) {
        setMessages((prev) => (freshRoom ? incoming : [...prev, ...incoming]));
      }
      for (const sig of data.signals) sinceSig.current = Math.max(sinceSig.current, sig.id);
      syncCalls(data);
      setPhase("chat");
      return changed || data.messages.length > 0 || data.signals.length > 0;
    };

    /**
     * Long polling: each request waits at the server until there is news for
     * us (a message, a call signal, someone joining or leaving, a match) or
     * about 25 seconds pass. So a quiet chat costs a couple of requests a
     * minute, yet messages still arrive the instant they are sent.
     */
    const run = async () => {
      while (!stop) {
        if (pausePoll.current) {
          await sleep(150);
          continue;
        }
        const ticket = epoch.current;
        const profile = profileRef.current;
        const startedAt = Date.now();
        try {
          const data = await post(
            {
              op: "poll",
              peerId: who.peerId,
              secret: who.secret,
              nick: profile.nick,
              country: profile.country,
              interests: profile.interests,
              mode: profile.mode,
              group: profile.group,
              queue: phase === "search",
              sinceMsg: sinceMsg.current,
              sinceSig: sinceSig.current,
              state: roomState.current,
              hold: true,
            },
            ctl.signal,
          );
          if (stop) return;
          if (ticket !== epoch.current) continue; // answer to an older search/chat: ignore
          const fresh = apply(data, profile);
          // A server that answers at once with nothing new (older server, or an
          // odd state) must not be hammered: fall back to roughly one a second.
          const took = Date.now() - startedAt;
          if (!fresh && took < 1000) await sleep(1000 - took);
        } catch (err) {
          if (stop || ctl.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Connection problem.");
          await sleep(2000);
        }
      }
    };
    void run();

    return () => {
      stop = true;
      ctl.abort();
    };
  }, [phase, closeCall, releaseMedia, syncCalls, nextLocalId, kick]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, phase, room?.typing.length]);

  useEffect(() => {
    const titles: Record<Phase, string> = {
      lobby: "Omegle",
      search: "Searching · Omegle",
      chat: "Chatting · Omegle",
      ended: "Disconnected · Omegle",
    };
    document.title = titles[phase];
  }, [phase]);

  function remember(next?: {
    mode?: ChatMode;
    group?: boolean;
    interests?: string[];
    nick?: string;
    country?: string;
  }) {
    const payload = {
      mode: next?.mode ?? mode,
      group: next?.group ?? group,
      nick: next?.nick ?? nick,
      country: next?.country ?? country,
      interests: next?.interests ?? interests,
    };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(payload));
  }

  async function openMedia(nextMode: ChatMode, nextGroup: boolean) {
    setMediaError(null);
    try {
      await acquire(nextMode, nextGroup);
      return true;
    } catch {
      setMediaError(
        nextMode === "video"
          ? "Camera is blocked here. You can still start a text chat."
          : "Microphone is blocked here. You can still start a text chat.",
      );
      return false;
    }
  }

  async function chooseMode(next: ChatMode) {
    setMode(next);
    remember({ mode: next });
    await openMedia(next, group);
  }

  async function chooseGroup(next: boolean) {
    setGroup(next);
    remember({ group: next });
    // Group video is requested at a lighter quality, so re-open the camera.
    if (mode === "video" && media) await openMedia(mode, next);
  }

  function addInterest(raw: string) {
    const value = raw.trim().replace(/,/g, "").slice(0, 24);
    if (!value) return;
    setInterests((prev) => {
      if (prev.some((item) => item.toLowerCase() === value.toLowerCase()) || prev.length >= 8) return prev;
      const next = [...prev, value];
      remember({ interests: next });
      return next;
    });
    setDraftInterest("");
  }

  function removeInterest(value: string) {
    setInterests((prev) => {
      const next = prev.filter((item) => item !== value);
      remember({ interests: next });
      return next;
    });
  }

  function resetRoomState() {
    sinceMsg.current = 0;
    sinceSig.current = 0;
    seenEcho.current = [];
    greeted.current = null;
    roomState.current = "";
    lastTyping.current = 0;
    knownMembers.current = new Map();
    setMessages([]);
    setRoom(null);
    setText("");
    setEndedNote(null);
  }

  async function start() {
    setError(null);
    if (!adult) return;
    if (me && me.usage.remainingMs <= 0) {
      setLimitInfo(me.usage);
      return;
    }
    localStorage.setItem(ADULT_KEY, "1");
    remember();
    if (mode !== "text" && !mediaRef.current) {
      if (!(await openMedia(mode, group))) {
        setError("Allow the microphone or camera, or switch to text.");
        return;
      }
    }
    epoch.current += 1;
    resetRoomState();
    closeCall();
    setPhase("search");
  }

  async function cancelSearch() {
    const who = identity.current;
    epoch.current += 1;
    setPhase("lobby");
    if (!who) return;
    await post({ op: "stop", peerId: who.peerId, secret: who.secret }).catch(() => {});
  }

  async function skip() {
    const who = identity.current;
    if (!who) return;
    epoch.current += 1;
    closeCall();
    resetRoomState();
    setPhase("search");
    pausePoll.current = true;
    try {
      await post({ op: "next", peerId: who.peerId, secret: who.secret });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip.");
    } finally {
      pausePoll.current = false;
      setKick((value) => value + 1);
    }
  }

  async function stopChat() {
    const who = identity.current;
    epoch.current += 1;
    setPhase("lobby");
    resetRoomState();
    releaseMedia();
    if (!who) return;
    await post({ op: "stop", peerId: who.peerId, secret: who.secret }).catch(() => {});
  }

  async function send() {
    const who = identity.current;
    const body = text.trim();
    if (!who || !body || phase !== "chat") return;
    setText("");
    lastTyping.current = 0;
    seenEcho.current.push(body);
    const id = nextLocalId();
    setMessages((prev) => [...prev, { id, from: "you", body, at: Date.now() }]);
    try {
      await post({ op: "send", peerId: who.peerId, secret: who.secret, text: body });
    } catch (err) {
      seenEcho.current = seenEcho.current.filter((item) => item !== body);
      setMessages((prev) => prev.filter((item) => item.id !== id));
      setText(body);
      setError(err instanceof Error ? err.message : "Message was not sent.");
    }
  }

  function enableSound() {
    const els = stage.current?.querySelectorAll<HTMLMediaElement>("[data-remote]") ?? [];
    void Promise.all([...els].map((el) => el.play())).then(
      () => setSoundBlocked(false),
      () => setSoundBlocked(true),
    );
  }

  function toggleMute() {
    media?.setMuted(!(mixerState?.muted ?? false));
  }

  function toggleCam() {
    const next = !camOff;
    setCamOff(next);
    media?.setCameraOff(next);
  }

  function announceMusic() {
    // Tell the room what's playing, as an ordinary chat line.
    const who = identity.current;
    const state = media?.state;
    const track = state ? state.queue[state.index] : undefined;
    if (!who || !track || phase !== "chat") return;
    const body = `🎵 Playing “${track.name}”`.slice(0, 200);
    seenEcho.current.push(body);
    setMessages((prev) => [...prev, { id: nextLocalId(), from: "you", body, at: Date.now() }]);
    void post({ op: "send", peerId: who.peerId, secret: who.secret, text: body }).catch(() => {});
  }

  /** Tell the room we're typing (at most every 1.5s), or that we stopped. */
  function notifyTyping(on: boolean) {
    const who = identity.current;
    if (!who || phase !== "chat") return;
    const now = Date.now();
    if (on) {
      if (now - lastTyping.current < 1500) return;
      lastTyping.current = now;
    } else {
      if (lastTyping.current === 0) return;
      lastTyping.current = 0;
    }
    void post({ op: "typing", peerId: who.peerId, secret: who.secret, typing: on }).catch(() => {});
  }

  function openPair() {
    remember();
    localStorage.setItem(ADULT_KEY, adult ? "1" : localStorage.getItem(ADULT_KEY) ?? "0");
    const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
    window.open(`${prefix}/?pair=1`, "_blank");
  }

  const shared = useMemo(() => {
    if (!room || room.kind === "group") return [];
    const theirs = new Set(room.members.flatMap((m) => m.interests.map((item) => item.toLowerCase())));
    return interests.filter((item) => theirs.has(item.toLowerCase()));
  }, [room, interests]);

  const places = stats?.places ?? [];
  const isGroup = room ? room.kind === "group" : group;
  const members = room?.members ?? [];
  const typingNames = (room?.typing ?? [])
    .map((id) => members.find((m) => m.id === id)?.nick)
    .filter((name): name is string => !!name);
  const muted = mixerState?.muted ?? false;

  return (
    <main className="mx-auto flex h-dvh w-full max-w-5xl flex-col overflow-hidden px-4 sm:px-6">
      {phase === "lobby" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between py-3">
            <p className="flex items-center gap-2 text-sm text-muted">
              <span className="relative flex size-2">
                <span className="radar absolute inline-flex size-2 rounded-full bg-primary" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              <span className="tabular-nums">{stats ? `${stats.online} online` : "Live"}</span>
              {stats && stats.countries > 0 && (
                <span className="text-muted">
                  · {stats.countries} {stats.countries === 1 ? "country" : "countries"}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <GhostButton onClick={() => setSheet("account")}>
                <UserRound className="size-4" />
                {me?.account ? "Account" : "Sign in"}
              </GhostButton>
              <GhostButton onClick={() => setSheet("safety")}>
                <Shield className="size-4" />
                Safety
              </GhostButton>
              <GhostButton onClick={() => setSheet("host")}>
                <Radio className="size-4" />
                Host
              </GhostButton>
              <ThemeToggle theme={theme} onChange={setTheme} />
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-14">
            <div className="shrink-0 lg:flex lg:w-5/12 lg:flex-col lg:justify-center">
              <p className="font-display text-5xl italic tracking-tight text-fg sm:text-6xl">Omegle</p>
              <p className="mt-2 max-w-md text-pretty text-muted">
                A stranger, somewhere else. Text, voice, or video — one-on-one or in a group of up to {GROUP_MAX}. No
                account needed, no history once you leave.
              </p>
              {me && (
                <p className="mt-2 max-w-md text-sm text-pretty text-muted" data-testid="usage-line">
                  {me.account
                    ? me.usage.remainingMs > 0
                      ? `Chat time left: ${clock(me.usage.remainingMs)} of ${waitText(me.usage.allowMs)}. It refreshes ${waitText(me.usage.refreshMs ?? 0)} after you use it all.`
                      : `You’ve used your chat time. It’s back in ${waitText((me.usage.resetAt ?? Date.now()) - Date.now())}.`
                    : me.usage.remainingMs > 0
                      ? `Free chat time: ${clock(me.usage.remainingMs)} of ${waitText(me.usage.allowMs)}. `
                      : "You’ve used your free chat time. "}
                  {!me.account && (
                    <button type="button" className="text-primary underline" onClick={() => setSheet("account")}>
                      Create a free account for more
                    </button>
                  )}
                </p>
              )}
              {places.length > 0 && (
                <p className="mt-3 text-sm text-muted">
                  In the lobby: {places.map((place) => place.country).join(" · ")}
                </p>
              )}
            </div>

            <div className="mt-4 flex min-h-0 flex-1 flex-col lg:mt-0">
              <div className="min-h-0 flex-1 overflow-y-auto pb-3">
                <div className="grid grid-cols-3 gap-2">
                  {(["text", "voice", "video"] as const).map((item) => {
                    const on = mode === item;
                    return (
                      <button
                        key={item}
                        type="button"
                        onClick={() => void chooseMode(item)}
                        className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-sm font-medium transition-transform duration-150 ease-out active:scale-[0.96] ${
                          on ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-fg"
                        }`}
                      >
                        <ModeIcon mode={item} className="size-5" />
                        {item === "text" ? "Text" : item === "voice" ? "Voice" : "Video"}
                      </button>
                    );
                  })}
                </div>

                <p className="mt-5 text-sm text-muted">Who with</p>
                <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Who with">
                  <button
                    type="button"
                    aria-pressed={!group}
                    onClick={() => void chooseGroup(false)}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2 py-3 text-sm font-medium transition-transform duration-150 ease-out active:scale-[0.96] ${
                      !group ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-fg"
                    }`}
                  >
                    <User className="size-5" strokeWidth={1.75} />
                    One-on-one
                  </button>
                  <button
                    type="button"
                    aria-pressed={group}
                    onClick={() => void chooseGroup(true)}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2 py-3 text-sm font-medium transition-transform duration-150 ease-out active:scale-[0.96] ${
                      group ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-fg"
                    }`}
                  >
                    <Users className="size-5" strokeWidth={1.75} />
                    Group · up to {GROUP_MAX}
                  </button>
                </div>
                {group && (
                  <p className="mt-2 text-sm text-pretty text-muted">
                    You’ll join a room of up to {GROUP_MAX} people. Rooms that still have space take newcomers, so you
                    may join one that’s already talking.
                  </p>
                )}

                {mode === "video" && localStream && (
                  <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface">
                    <LocalVideo stream={localStream} className="aspect-video w-full object-cover" />
                  </div>
                )}
                {mediaError && <p className="mt-3 text-sm text-hot">{mediaError}</p>}
                {mode !== "text" && (
                  <p className="mt-3 text-sm text-pretty text-muted">
                    Voice and video connect directly
                    {group ? ", so everyone in the group can learn your network address" : ", so the other person may learn your network address"}
                    . Text stays on the server. You can play music into the call once you’re connected.
                  </p>
                )}

                <label className="mt-6 block text-sm text-muted" htmlFor="nick">
                  What they call you
                </label>
                <input
                  id="nick"
                  value={nick}
                  maxLength={20}
                  autoComplete="off"
                  placeholder="Stranger"
                  onChange={(event) => {
                    setNick(event.target.value);
                    remember({ nick: event.target.value });
                  }}
                  className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  suppressHydrationWarning
                />

                <label className="mt-4 block text-sm text-muted" htmlFor="country">
                  You appear from
                </label>
                <div className="relative mt-2">
                  <Globe className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <select
                    id="country"
                    value={country}
                    onChange={(event) => {
                      setCountry(event.target.value);
                      remember({ country: event.target.value });
                    }}
                    className="min-h-11 w-full appearance-none rounded-lg border border-line bg-surface pr-3 pl-10 text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    suppressHydrationWarning
                  >
                    {COUNTRIES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="mt-4 block text-sm text-muted" htmlFor="interest">
                  Interests — similar tags meet first
                </label>
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addInterest(draftInterest);
                  }}
                >
                  <input
                    id="interest"
                    value={draftInterest}
                    maxLength={24}
                    autoComplete="off"
                    placeholder="Add one"
                    onChange={(event) => setDraftInterest(event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    suppressHydrationWarning
                  />
                  <button
                    type="submit"
                    className="min-h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg transition-transform duration-150 ease-out active:scale-[0.96]"
                  >
                    Add
                  </button>
                </form>
                <div className="chip-row mt-3 flex gap-2 overflow-x-auto">
                  {SUGGESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => addInterest(item)}
                      className="shrink-0 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-fg"
                    >
                      {item}
                    </button>
                  ))}
                </div>
                {interests.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {interests.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => removeInterest(item)}
                        className="inline-flex min-h-11 items-center gap-1 rounded-full bg-primary px-3 text-sm font-medium text-primary-fg"
                      >
                        {item}
                        <X className="size-3.5" />
                      </button>
                    ))}
                  </div>
                )}

                <label className="mt-6 flex items-start gap-3 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={adult}
                    onChange={(event) => {
                      setAdult(event.target.checked);
                      localStorage.setItem(ADULT_KEY, event.target.checked ? "1" : "0");
                    }}
                    className="mt-0.5 size-5 accent-primary"
                    suppressHydrationWarning
                  />
                  <span>I am 18 or older. I won’t share personal contact details.</span>
                </label>
                {error && <p className="mt-3 text-sm text-hot">{error}</p>}
              </div>

              <div className="safe-bottom shrink-0 border-t border-line bg-bg py-3">
                <button
                  type="button"
                  disabled={!adult}
                  onClick={() => void start()}
                  className="min-h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-fg transition-transform duration-150 ease-out active:scale-[0.96] disabled:opacity-40"
                >
                  {group ? "Find a group" : "Start"}
                </button>
                <button type="button" onClick={openPair} className="mt-1 min-h-11 w-full text-sm text-muted">
                  Testing alone? Open another tab and you’ll meet each other.
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "search" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 justify-end py-3">
            <ThemeToggle theme={theme} onChange={setTheme} />
          </header>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="relative flex size-16 items-center justify-center">
              <span className="radar absolute inline-flex size-16 rounded-full bg-primary" />
              <span className="relative inline-flex size-4 rounded-full bg-primary" />
            </span>
            <h1 className="font-display mt-8 text-4xl italic">{group ? "Finding a group" : "Looking"}</h1>
            <p className="mt-3 max-w-sm text-pretty text-muted">
              {interests.length > 0
                ? `First ${group ? "people" : "someone"} who share${group ? "" : "s"} ${interests.slice(0, 3).join(", ")}. Then ${
                    group ? "any group" : "anyone"
                  } in ${mode}.`
                : group
                  ? `A group of up to ${GROUP_MAX} for ${mode}. You’ll join one that has space, or start one.`
                  : `Anyone ready for ${mode}.`}
            </p>
            <p className="mt-2 text-sm text-muted tabular-nums">
              {stats ? `${stats.waiting} waiting · ${stats.online} online` : "Connecting to the lobby"}
            </p>
            {error && <p className="mt-4 text-sm text-hot">{error}</p>}
            <button
              type="button"
              onClick={() => void cancelSearch()}
              className="mt-8 min-h-11 rounded-xl border border-line px-6 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(phase === "chat" || phase === "ended") && (
        <div className="flex min-h-0 flex-1 flex-col py-3 sm:py-4">
          <header className="flex items-start justify-between gap-3 border-b border-line pb-3">
            <div className="min-w-0">
              <p className="text-xs tracking-wide text-muted uppercase">
                {phase === "ended"
                  ? "Disconnected"
                  : `${isGroup ? `Group ${members.length + 1}/${room?.capacity ?? GROUP_MAX} · ` : ""}${
                      mode === "text" ? "Text" : overallLabel(peers, members.length)
                    }`}
              </p>
              <h1 className="truncate text-lg font-semibold">
                {isGroup
                  ? members.length > 0
                    ? members.map((m) => m.nick).join(", ")
                    : "Waiting for others to join"
                  : members[0]
                    ? `${members[0].nick} · ${members[0].country}`
                    : "Stranger"}
              </h1>
              {shared.length > 0 && <p className="mt-1 text-sm text-primary">You both like {shared.join(", ")}</p>}
              {phase === "chat" && usage && (
                <p
                  className={`mt-1 text-sm tabular-nums ${remainingNow(usage) < 60_000 ? "text-hot" : "text-muted"}`}
                  data-testid="time-left"
                >
                  Time left {clock(remainingNow(usage))}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle theme={theme} onChange={setTheme} />
              {phase === "chat" && (
                <button
                  type="button"
                  onClick={() => void skip()}
                  className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-sm font-medium transition-transform duration-150 ease-out active:scale-[0.96]"
                >
                  <SkipForward className="size-4" />
                  {isGroup ? "Next group" : "Next"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void stopChat()}
                className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-hot px-3 text-sm font-semibold text-primary-fg transition-transform duration-150 ease-out active:scale-[0.96]"
              >
                <Square className="size-4" />
                Stop
              </button>
            </div>
          </header>

          <div className={`mt-3 flex min-h-0 flex-1 flex-col gap-3 ${mode !== "text" ? "lg:flex-row" : ""}`}>
            {mode !== "text" && (
              <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface lg:w-[46%]">
                <div ref={stage} className="relative min-h-0 flex-1">
                  {isGroup ? (
                    <div className="grid grid-cols-2 gap-1.5 p-1.5 lg:min-h-80 lg:content-start">
                      {members.map((member) => {
                        const peer = peers.find((p) => p.id === member.id);
                        return (
                          <Tile
                            key={member.id}
                            label={`${member.nick} · ${member.country}`}
                            video={mode === "video"}
                            stream={peer?.stream ?? null}
                            state={peer?.state ?? "new"}
                            onBlocked={() => setSoundBlocked(true)}
                          />
                        );
                      })}
                      <Tile
                        label={`You${muted ? " · muted" : ""}`}
                        video={mode === "video"}
                        stream={localStream}
                        self
                        state="connected"
                      />
                      {members.length === 0 && (
                        <p className="col-span-2 px-2 py-3 text-center text-sm text-pretty text-muted">
                          You’re the only one here for now. Anyone who picks Group will be placed in this room.
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      {mode === "video" ? (
                        <RemoteMedia
                          video
                          stream={peers[0]?.stream ?? null}
                          onBlocked={() => setSoundBlocked(true)}
                          className="aspect-video w-full bg-bg object-cover lg:aspect-auto lg:h-full lg:min-h-80"
                        />
                      ) : (
                        <div className="flex aspect-video flex-col items-center justify-center gap-3 lg:aspect-auto lg:h-full lg:min-h-80">
                          <span className="relative flex size-20 items-center justify-center">
                            {peers[0]?.state === "connected" && (
                              <span className="radar absolute inline-flex size-20 rounded-full bg-primary" />
                            )}
                            <Mic className="relative size-8 text-primary" />
                          </span>
                          <p className="text-sm text-muted">{overallLabel(peers, members.length)}</p>
                          <RemoteMedia
                            video={false}
                            stream={peers[0]?.stream ?? null}
                            onBlocked={() => setSoundBlocked(true)}
                          />
                        </div>
                      )}
                      {mode === "video" && !peers[0]?.stream && (
                        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
                          Waiting for their camera
                        </p>
                      )}
                      {mode === "video" && (
                        <LocalVideo
                          stream={localStream}
                          className="absolute right-3 bottom-3 h-28 w-20 rounded-lg border border-line object-cover"
                        />
                      )}
                    </>
                  )}
                  {soundBlocked && (
                    <button
                      type="button"
                      onClick={enableSound}
                      className="absolute bottom-3 left-3 min-h-11 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg"
                    >
                      Tap for sound
                    </button>
                  )}
                  {peers.length > 0 && peers.every((p) => p.state === "failed") && (
                    <p className="absolute right-3 bottom-3 left-3 rounded-lg bg-bg/90 px-3 py-2 text-sm text-fg">
                      The call can’t connect through this network. Text still works.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 border-t border-line p-2">
                  <IconButton label={muted ? "Unmute microphone" : "Mute microphone"} onClick={toggleMute}>
                    {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                  </IconButton>
                  {mode === "video" && (
                    <IconButton label={camOff ? "Turn camera on" : "Turn camera off"} onClick={toggleCam}>
                      {camOff ? <VideoOff className="size-4" /> : <Video className="size-4" />}
                    </IconButton>
                  )}
                  {media?.supported && (
                    <>
                      <IconButton label="Play music into the call" onClick={() => setSheet("music")}>
                        <Music className="size-4" />
                      </IconButton>
                      {mixerState && mixerState.queue.length > 0 && (
                        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-bg px-2 text-sm">
                          <button
                            type="button"
                            aria-label={mixerState.playing ? "Pause music" : "Play music"}
                            onClick={() => media.toggle()}
                            className="inline-flex size-11 shrink-0 items-center justify-center"
                          >
                            {mixerState.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                          </button>
                          <span className="truncate text-muted">
                            {mixerState.queue[mixerState.index]?.name ?? "Music"}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            )}

            <section className="flex min-h-0 flex-1 flex-col">
              <div ref={scroller} className="flex min-h-48 flex-1 flex-col gap-2 overflow-y-auto py-1">
                {messages.map((message) =>
                  message.from === "system" ? (
                    <p key={message.id} className="px-2 py-2 text-center text-sm text-pretty text-muted">
                      {message.body}
                    </p>
                  ) : (
                    <div
                      key={message.id}
                      className={`flex ${message.from === "you" ? "justify-end" : "justify-start"}`}
                    >
                      <p
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-pretty break-words ${
                          message.from === "you" ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg"
                        }`}
                      >
                        {isGroup && message.from === "them" && message.nick && (
                          <span className="mb-0.5 block text-xs font-semibold opacity-80">{message.nick}</span>
                        )}
                        {message.body}
                        <span className="mt-1 block text-right text-xs tabular-nums opacity-70">
                          {formatTime(message.at)}
                        </span>
                      </p>
                    </div>
                  ),
                )}
                {phase === "chat" && typingNames.length > 0 && (
                  <p className="px-2 text-sm text-muted">{typingLabel(typingNames)}</p>
                )}
                {phase === "ended" && (
                  <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-4 text-center">
                    <p className="font-medium">
                      {endedNote ?? (isGroup ? "This group has ended." : "Stranger disconnected.")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void start()}
                      className="mt-3 min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg"
                    >
                      {isGroup ? "New group" : "New stranger"}
                    </button>
                  </div>
                )}
              </div>

              {phase === "chat" && (
                <form
                  className="safe-bottom flex gap-2 pt-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <input
                    value={text}
                    maxLength={400}
                    autoComplete="off"
                    placeholder={isGroup && members.length === 0 ? "Waiting for others…" : "Say hi"}
                    onChange={(event) => {
                      setText(event.target.value);
                      notifyTyping(event.target.value.trim().length > 0);
                    }}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                  <button
                    type="submit"
                    aria-label="Send"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-primary text-primary-fg transition-transform duration-150 ease-out active:scale-[0.96]"
                  >
                    <Send className="size-4" />
                  </button>
                </form>
              )}
              {error && phase === "chat" && <p className="pt-2 text-sm text-hot">{error}</p>}
            </section>
          </div>
        </div>
      )}

      {sheet && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-bg/80 p-3 sm:items-center">
          <div className="safe-bottom max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-3xl italic">
                {sheet === "safety"
                  ? "Before you talk"
                  : sheet === "host"
                    ? "Run it yourself"
                    : sheet === "account"
                      ? me?.account
                        ? "Your account"
                        : "Create an account"
                      : "Music"}
              </h2>
              <button type="button" aria-label="Close" onClick={() => setSheet(null)} className="min-h-11 min-w-11">
                <X className="size-5" />
              </button>
            </div>
            {sheet === "account" &&
              (me?.account ? (
                <div className="mt-4 space-y-3 text-sm">
                  <p className="break-all">
                    Signed in as <span className="font-medium">{me.account.email}</span>
                  </p>
                  <p className="text-pretty text-muted">
                    Chat time: {me.usage.remainingMs > 0 ? `${clock(me.usage.remainingMs)} left of ${waitText(me.usage.allowMs)}` : `used up — back in ${waitText((me.usage.resetAt ?? Date.now()) - Date.now())}`}
                    . It refreshes {quota.accountRefreshHours} {quota.accountRefreshHours === 1 ? "hour" : "hours"} after you use it all.
                  </p>
                  {me.account.admin && (
                    <a className="inline-flex min-h-11 items-center text-primary underline" href="/admin">
                      Open the admin dashboard
                    </a>
                  )}
                  <button
                    type="button"
                    className="block min-h-11 rounded-lg border border-line px-4 font-medium"
                    onClick={() => void signOut().then(() => setSheet(null))}
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <AuthPanel
                  intro={`Without an account you get ${quota.guestMinutes} minutes of chat in total. With a free account you get ${quota.accountMinutes} minutes, and it refreshes ${quota.accountRefreshHours} ${quota.accountRefreshHours === 1 ? "hour" : "hours"} after you use it up.`}
                  onDone={() => {
                    setSheet(null);
                    setLimitInfo(null);
                    void refreshMe();
                  }}
                />
              ))}
            {sheet === "safety" && <SafetyCopy />}
            {sheet === "host" && <HostCopy />}
            {sheet === "music" && media && mixerState && (
              <MusicPanel mixer={media} state={mixerState} onPlayed={announceMusic} />
            )}
          </div>
        </div>
      )}
      {limitInfo && !sheet && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-bg/80 p-3 sm:items-center">
          <div
            role="dialog"
            aria-label="Chat time used up"
            className="safe-bottom w-full max-w-lg rounded-xl border border-line bg-surface p-5"
          >
            <h2 className="font-display text-3xl italic">Time’s up for now</h2>
            {limitInfo.kind === "account" ? (
              <p className="mt-3 text-pretty text-muted">
                You’ve used your {waitText(limitInfo.allowMs)} of chat time. It comes back in{" "}
                <span className="font-medium text-fg">{waitText((limitInfo.resetAt ?? Date.now()) - Date.now())}</span>.
              </p>
            ) : (
              <p className="mt-3 text-pretty text-muted">
                You’ve used your {waitText(limitInfo.allowMs)} of free chat time, and it doesn’t come back. Create a free
                account with just your email to get {quota.accountMinutes} minutes, refreshed every {quota.accountRefreshHours}{" "}
                {quota.accountRefreshHours === 1 ? "hour" : "hours"}.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {limitInfo.kind === "guest" && (
                <button
                  type="button"
                  className="min-h-11 flex-1 rounded-lg bg-primary px-4 font-semibold text-primary-fg"
                  onClick={() => setSheet("account")}
                >
                  Create an account
                </button>
              )}
              <button
                type="button"
                className="min-h-11 flex-1 rounded-lg border border-line px-4 font-medium"
                onClick={() => setLimitInfo(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <InstallBanner />
    </main>
  );
}

function remainingNow(usage: { info: UsageInfo; at: number }): number {
  return Math.max(0, usage.info.remainingMs - (Date.now() - usage.at));
}

function intro(room: PollChat, yours: string[]) {
  if (room.kind === "group") {
    if (room.members.length === 0) {
      return `You're in a group room (up to ${room.capacity} people). You're the only one here for now — others will join. Say hi.`;
    }
    return `You're now in a group with ${room.members.map((m) => m.nick).join(", ")}. Say hi.`;
  }
  const partner = room.members[0];
  const shared = partner
    ? yours.filter((item) => partner.interests.some((t) => t.toLowerCase() === item.toLowerCase()))
    : [];
  const like = shared.length > 0 ? ` You both like ${shared.join(", ")}.` : "";
  return `You're now chatting with a stranger from ${partner?.country ?? "somewhere"}.${like} Say hi.`;
}

function callLabel(state: RTCPeerConnectionState | "off") {
  if (state === "connected") return "Live";
  if (state === "failed") return "Call failed";
  if (state === "disconnected") return "Reconnecting";
  return "Connecting";
}

/** One word for the whole call: live if anyone is connected. */
function overallLabel(peers: PeerMedia[], others: number) {
  if (others === 0) return "Waiting";
  if (peers.some((p) => p.state === "connected")) return "Live";
  if (peers.length > 0 && peers.every((p) => p.state === "failed")) return "Call failed";
  return callLabel(peers[0]?.state ?? "off");
}

function typingLabel(names: string[]) {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return "Several people are typing";
}

function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function GhostButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-fg"
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg text-fg"
    >
      {children}
    </button>
  );
}

/** Your own camera. Always muted so you never hear yourself. */
function LocalVideo({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className={className} />;
}

/** Plays someone else's stream: a <video> for video calls, a hidden <audio> for voice. */
function RemoteMedia({
  stream,
  video,
  className,
  onBlocked,
}: {
  stream: MediaStream | null;
  video: boolean;
  className?: string;
  onBlocked?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Kept in a ref so a new callback each render doesn't restart playback.
  const blocked = useRef(onBlocked);
  blocked.current = onBlocked;
  useEffect(() => {
    const el = video ? videoRef.current : audioRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().then(undefined, () => blocked.current?.());
  }, [stream, video]);
  return video ? (
    <video ref={videoRef} data-remote autoPlay playsInline className={className} />
  ) : (
    <audio ref={audioRef} data-remote autoPlay />
  );
}

/** One person in a group call: video, or an avatar for voice. */
function Tile({
  label,
  video,
  stream,
  state,
  self = false,
  onBlocked,
}: {
  label: string;
  video: boolean;
  stream: MediaStream | null;
  state: RTCPeerConnectionState;
  self?: boolean;
  onBlocked?: () => void;
}) {
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-bg">
      {video ? (
        self ? (
          <LocalVideo stream={stream} className="h-full w-full -scale-x-100 object-cover" />
        ) : (
          <RemoteMedia video stream={stream} onBlocked={onBlocked} className="h-full w-full object-cover" />
        )
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1">
          <span className="relative flex size-12 items-center justify-center">
            {state === "connected" && !self && <span className="radar absolute inline-flex size-12 rounded-full bg-primary" />}
            <span className="relative inline-flex size-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-fg">
              {initial}
            </span>
          </span>
          {!self && <RemoteMedia video={false} stream={stream} onBlocked={onBlocked} />}
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[90%] truncate rounded bg-bg/85 px-1.5 py-0.5 text-xs text-fg">
        {label}
        {!self && state !== "connected" ? ` · ${callLabel(state)}` : ""}
      </span>
    </div>
  );
}

function MusicPanel({
  mixer,
  state,
  onPlayed,
}: {
  mixer: Mixer;
  state: MixerState;
  onPlayed: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const current = state.queue[state.index];

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const before = mixer.state.index;
    const added = mixer.addFiles(Array.from(files));
    if (added > 0 && before < 0) onPlayed();
    if (input.current) input.current.value = "";
  }

  return (
    <div className="mt-4 space-y-4 text-sm text-pretty">
      <p className="text-muted">
        Pick songs from your device and everyone in the call hears them, mixed with your voice. Files are played
        straight from your phone or computer — nothing is uploaded to a server. Only share music you have the right to
        play, and use headphones to avoid echo.
      </p>

      <input
        ref={input}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus"
        multiple
        className="sr-only"
        id="music-file"
        data-testid="music-file"
        onChange={(event) => pick(event.target.files)}
      />
      <label
        htmlFor="music-file"
        className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-primary-fg"
      >
        <Music className="size-4" />
        Add songs
      </label>

      {state.error && <p className="text-hot">{state.error}</p>}

      {state.queue.length > 0 && (
        <>
          <div className="rounded-lg bg-bg p-3">
            <p className="truncate font-medium" data-testid="now-playing">
              {current ? current.name : "Nothing playing"}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous song"
                onClick={() => mixer.previous()}
                className="inline-flex size-11 items-center justify-center rounded-lg border border-line"
              >
                <SkipBack className="size-4" />
              </button>
              <button
                type="button"
                aria-label={state.playing ? "Pause music" : "Play music"}
                onClick={() => mixer.toggle()}
                className="inline-flex size-11 items-center justify-center rounded-lg bg-primary text-primary-fg"
              >
                {state.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </button>
              <button
                type="button"
                aria-label="Next song"
                onClick={() => mixer.next()}
                className="inline-flex size-11 items-center justify-center rounded-lg border border-line"
              >
                <SkipForward className="size-4" />
              </button>
              <button
                type="button"
                aria-pressed={state.loop}
                aria-label="Repeat the list"
                onClick={() => mixer.setLoop(!state.loop)}
                className={`inline-flex size-11 items-center justify-center rounded-lg border ${
                  state.loop ? "border-primary text-primary" : "border-line text-muted"
                }`}
              >
                <Repeat className="size-4" />
              </button>
            </div>
            <label className="mt-3 flex items-center gap-3 text-muted">
              <Volume2 className="size-4 shrink-0" />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(state.volume * 100)}
                aria-label="Music volume"
                onChange={(event) => mixer.setVolume(Number(event.target.value) / 100)}
                className="h-11 min-w-0 flex-1 accent-primary"
              />
            </label>
          </div>

          <ul className="space-y-1">
            {state.queue.map((track, i) => (
              <li key={track.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => mixer.playIndex(i)}
                  className={`min-h-11 min-w-0 flex-1 truncate rounded-lg px-3 text-left ${
                    i === state.index ? "bg-surface-2 font-medium text-fg" : "text-muted"
                  }`}
                >
                  {i === state.index && state.playing ? "▶ " : ""}
                  {track.name}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${track.name}`}
                  onClick={() => mixer.remove(track.id)}
                  className="inline-flex size-11 shrink-0 items-center justify-center text-muted"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SafetyCopy() {
  return (
    <div className="mt-4 space-y-3 text-sm text-pretty text-muted">
      <p>
        Omegle is for adults. You can be paired with anyone, in any country, who picked the same mode — one-on-one, or
        in a group of up to {GROUP_MAX}.
      </p>
      <p>Hit Next to leave a chat instantly. Nothing you type is kept after the chat ends.</p>
      <p>
        Text goes through the server, so strangers don’t need a direct link to read it. Voice and video are direct
        calls — like a phone call — and can reveal a network address to everyone in the call. In a group, that’s every
        member. Stay on text if that matters.
      </p>
      <p>
        Music you play comes from your own device and is heard by everyone in the call. Only play what you’re allowed
        to share.
      </p>
      <p>Don’t share your full name, school, phone number, or where you live.</p>
    </div>
  );
}

function HostCopy() {
  return (
    <div className="mt-4 space-y-3 text-sm text-pretty text-muted">
      <p>
        Anyone with this page can join from a phone browser. Termux is only if you want the pairing server running on
        an Android phone.
      </p>
      <p className="text-fg">Termux</p>
      <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-xs text-fg">
        {`pkg install nodejs git\ngit clone <this project>\ncd <project>\nnpm install\nnpm run termux`}
      </pre>
      <p>
        Camera, microphone and music need a secure address. On the same phone, <span className="text-fg">localhost</span>{" "}
        works. For friends on other devices, point a Cloudflare Tunnel at the phone — Cloudflare gives it an https
        address, the phone keeps pairing people.
      </p>
      <p className="text-fg">Cloudflare Workers</p>
      <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-xs text-fg">{`npm install\nnpm run cf:deploy`}</pre>
      <p>
        The <span className="text-fg">cloudflare</span> folder hosts this same app as a Worker plus a Durable Object
        lobby, with text, voice, video, groups and music. Calls use public STUN servers; add a TURN server if some
        networks can’t connect.
      </p>
    </div>
  );
}
