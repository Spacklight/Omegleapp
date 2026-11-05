import type { WireSignal } from "@/lib/omegle/protocol";

export type SignalKind = "offer" | "answer" | "ice";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

/**
 * One direct call to one person. Text never uses this — only voice and video.
 * The lexicographically smaller peer id is polite and yields on glare.
 * There is no TURN relay: a strict NAT can fail the call. Text still works.
 */
export class DuoCall {
  readonly pc: RTCPeerConnection;
  readonly remote = new MediaStream();
  private makingOffer = false;
  private ignoreOffer = false;
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;
  private readonly polite: boolean;
  private readonly send: (kind: SignalKind, payload: unknown) => void;
  private readonly onState: (state: RTCPeerConnectionState) => void;

  constructor(
    polite: boolean,
    local: MediaStream,
    send: (kind: SignalKind, payload: unknown) => void,
    onState: (state: RTCPeerConnectionState) => void,
  ) {
    this.polite = polite;
    this.send = send;
    this.onState = onState;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    for (const track of local.getTracks()) this.pc.addTrack(track, local);
    this.pc.ontrack = (event) => {
      const tracks = event.streams[0]?.getTracks() ?? [event.track];
      for (const track of tracks) {
        if (!this.remote.getTracks().some((t) => t.id === track.id)) this.remote.addTrack(track);
      }
      this.onState(this.pc.connectionState);
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.send("ice", event.candidate.toJSON());
    };
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.onnegotiationneeded = () => {
      void this.offer();
    };
  }

  private async offer() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) this.send("offer", this.pc.localDescription.toJSON());
    } catch {
      // The next negotiationneeded, or the peer's offer, retries.
    } finally {
      this.makingOffer = false;
    }
  }

  async take(kind: SignalKind, payload: unknown) {
    if (this.closed) return;
    try {
      if (kind === "offer" || kind === "answer") {
        const description = payload as RTCSessionDescriptionInit;
        const collision =
          kind === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (kind === "offer") {
          await this.pc.setLocalDescription();
          if (this.pc.localDescription) this.send("answer", this.pc.localDescription.toJSON());
        }
        await this.flush();
      } else {
        const candidate = payload as RTCIceCandidateInit;
        if (!this.pc.remoteDescription) {
          this.pending.push(candidate);
          return;
        }
        await this.pc.addIceCandidate(candidate);
      }
    } catch {
      // A lost description is recovered by the next offer.
    }
  }

  private async flush() {
    while (this.pending.length > 0) {
      const candidate = this.pending.shift();
      if (!candidate) return;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        if (!this.ignoreOffer) break;
      }
    }
  }

  close() {
    this.closed = true;
    this.pc.close();
  }
}

export type PeerMedia = { id: string; stream: MediaStream; state: RTCPeerConnectionState };

/**
 * A full mesh: one DuoCall per other person in the room. With at most four
 * people that is at most three calls each, which phones handle fine.
 * Everyone sends the same local stream (mic mixed with any music, plus camera).
 */
export class MeshCall {
  private readonly calls = new Map<string, DuoCall>();
  private readonly states = new Map<string, RTCPeerConnectionState>();
  private readonly queued = new Map<string, WireSignal[]>();
  private closed = false;

  constructor(
    private readonly selfId: string,
    private readonly local: MediaStream,
    private readonly send: (to: string, kind: SignalKind, payload: unknown) => void,
    private readonly onChange: () => void,
  ) {}

  /** Open calls to new people, close calls to people who left. */
  sync(memberIds: string[]) {
    if (this.closed) return;
    const want = new Set(memberIds);
    for (const [id, call] of this.calls) {
      if (!want.has(id)) {
        call.close();
        this.calls.delete(id);
        this.states.delete(id);
        this.queued.delete(id);
        this.onChange();
      }
    }
    for (const id of memberIds) {
      if (this.calls.has(id)) continue;
      const call = new DuoCall(
        this.selfId < id,
        this.local,
        (kind, payload) => this.send(id, kind, payload),
        (state) => {
          this.states.set(id, state);
          this.onChange();
        },
      );
      this.calls.set(id, call);
      this.states.set(id, call.pc.connectionState);
      for (const sig of this.queued.get(id)?.splice(0) ?? []) void call.take(sig.kind, sig.payload);
      this.onChange();
    }
  }

  /** Route an incoming signal to the right call (or hold it until that call exists). */
  take(sig: WireSignal) {
    if (this.closed) return;
    const call = this.calls.get(sig.from);
    if (call) {
      void call.take(sig.kind, sig.payload);
      return;
    }
    const list = this.queued.get(sig.from) ?? [];
    if (list.length < 100) list.push(sig);
    this.queued.set(sig.from, list);
  }

  peers(): PeerMedia[] {
    return [...this.calls.entries()].map(([id, call]) => ({
      id,
      stream: call.remote,
      state: this.states.get(id) ?? call.pc.connectionState,
    }));
  }

  close() {
    this.closed = true;
    for (const call of this.calls.values()) call.close();
    this.calls.clear();
    this.states.clear();
    this.queued.clear();
  }
}

/** Group calls send video to up to three people at once, so ask for lighter video there. */
export async function openMic(video: boolean, group = false): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video
      ? group
        ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
        : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
      : false,
  });
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}
