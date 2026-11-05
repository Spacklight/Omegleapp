/**
 * Live audio mixer for voice and video calls.
 *
 * Your microphone and any music you load are mixed into ONE audio track, and
 * that track (plus your camera, if any) is what every person in the call
 * receives. Because the mix is built before the call starts, adding, pausing or
 * skipping music never needs a renegotiation — the other side just hears it.
 *
 * Music files are played straight from your device. Nothing is uploaded to the
 * server; the sound travels peer to peer like your voice does.
 */

export type MusicTrack = { id: number; name: string; url: string };

export type MixerState = {
  queue: MusicTrack[];
  index: number;
  playing: boolean;
  volume: number;
  loop: boolean;
  muted: boolean;
  error: string | null;
};

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba|mp4|3gp|amr)$/i;
export const MAX_QUEUE = 25;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor {
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("This browser can't mix audio.");
  return Ctor;
}

export function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
}

export class Mixer {
  /** What the other people receive: mixed audio, plus the camera track if there is one. */
  readonly out: MediaStream;

  /** False on browsers without Web Audio: calls still work, music is unavailable. */
  readonly supported: boolean;

  private readonly raw: MediaStream;
  private readonly ctx: AudioContext | null = null;
  private readonly micGain: GainNode | null = null;
  private readonly musicGain: GainNode | null = null;
  private readonly el: HTMLAudioElement = new Audio();
  private readonly listeners = new Set<(state: MixerState) => void>();
  private nextId = 1;
  private disposed = false;
  private s: MixerState = {
    queue: [],
    index: -1,
    playing: false,
    volume: 0.8,
    loop: false,
    muted: false,
    error: null,
  };

  constructor(raw: MediaStream) {
    this.raw = raw;
    try {
      const Ctor = audioContextCtor();
      const ctx = new Ctor();
      const dest = ctx.createMediaStreamDestination();

      const micGain = ctx.createGain();
      if (raw.getAudioTracks().length > 0) {
        ctx.createMediaStreamSource(new MediaStream(raw.getAudioTracks())).connect(micGain);
      }
      micGain.connect(dest);

      this.el.preload = "auto";
      const musicGain = ctx.createGain();
      musicGain.gain.value = this.s.volume;
      ctx.createMediaElementSource(this.el).connect(musicGain);
      musicGain.connect(dest); // what they hear
      musicGain.connect(ctx.destination); // what you hear

      this.ctx = ctx;
      this.micGain = micGain;
      this.musicGain = musicGain;
      this.out = new MediaStream([...dest.stream.getAudioTracks(), ...raw.getVideoTracks()]);
      this.supported = true;
      void ctx.resume().catch(() => {});
    } catch {
      this.out = raw;
      this.supported = false;
    }

    this.el.addEventListener("ended", () => this.advance());
    this.el.addEventListener("play", () => this.set({ playing: true }));
    this.el.addEventListener("pause", () => this.set({ playing: false }));
    this.el.addEventListener("error", () => {
      if (!this.el.getAttribute("src")) return;
      const bad = this.s.queue[this.s.index];
      this.set({ playing: false, error: bad ? `Couldn't play “${bad.name}”.` : "Couldn't play that file." });
      this.advance(true);
    });
  }

  get state(): MixerState {
    return this.s;
  }

  subscribe(fn: (state: MixerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<MixerState>) {
    if (this.disposed) return;
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  // ---- microphone ---------------------------------------------------------

  /** Mutes only your voice. Music keeps playing. */
  setMuted(muted: boolean) {
    if (this.micGain) this.micGain.gain.value = muted ? 0 : 1;
    else this.raw.getAudioTracks().forEach((track) => (track.enabled = !muted));
    this.set({ muted });
  }

  setCameraOff(off: boolean) {
    this.raw.getVideoTracks().forEach((track) => {
      track.enabled = !off;
    });
  }

  // ---- music --------------------------------------------------------------

  /** Add audio files to the queue. Returns how many were accepted. */
  addFiles(files: Iterable<File>): number {
    if (!this.supported) {
      this.set({ error: "This browser can't play music into calls." });
      return 0;
    }
    const queue = [...this.s.queue];
    let added = 0;
    let skipped = 0;
    for (const file of files) {
      if (!isAudioFile(file)) {
        skipped += 1;
        continue;
      }
      if (queue.length >= MAX_QUEUE) break;
      queue.push({ id: this.nextId++, name: file.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(file) });
      added += 1;
    }
    const error = added === 0 && skipped > 0 ? "That isn't an audio file. Try an MP3, WAV, M4A or OGG." : null;
    this.set({ queue, error });
    // Start the new song unless something is already loaded and still going.
    if (added > 0 && (this.s.index < 0 || this.el.ended)) this.playIndex(queue.length - added);
    return added;
  }

  private load(index: number) {
    const track = this.s.queue[index];
    if (!track) return false;
    this.el.src = track.url;
    this.set({ index, error: null });
    return true;
  }

  playIndex(index: number) {
    if (!this.load(index)) return;
    void this.ctx?.resume().catch(() => {});
    void this.el.play().catch(() => this.set({ playing: false }));
  }

  toggle() {
    if (this.s.index < 0) {
      if (this.s.queue.length > 0) this.playIndex(0);
      return;
    }
    if (this.el.paused) {
      void this.ctx?.resume().catch(() => {});
      void this.el.play().catch(() => this.set({ playing: false }));
    } else {
      this.el.pause();
    }
  }

  next() {
    const n = this.s.queue.length;
    if (n === 0) return;
    this.playIndex((this.s.index + 1) % n);
  }

  previous() {
    const n = this.s.queue.length;
    if (n === 0) return;
    // Restart the song first; go back only if it has just begun.
    if (this.el.currentTime > 3) this.el.currentTime = 0;
    else this.playIndex((this.s.index - 1 + n) % n);
  }

  /** Song finished (or failed): move on, or stop at the end of the queue. */
  private advance(failed = false) {
    const { queue, index, loop } = this.s;
    if (queue.length === 0) return;
    if (index + 1 < queue.length) this.playIndex(index + 1);
    else if (loop && !failed) this.playIndex(0); // a broken file must not loop forever
    else this.set({ playing: false });
  }

  setLoop(loop: boolean) {
    this.set({ loop });
  }

  setVolume(volume: number) {
    const v = Math.min(1, Math.max(0, volume));
    if (this.musicGain) this.musicGain.gain.value = v;
    this.set({ volume: v });
  }

  remove(id: number) {
    const i = this.s.queue.findIndex((t) => t.id === id);
    if (i < 0) return;
    const removed = this.s.queue[i];
    const queue = this.s.queue.filter((t) => t.id !== id);
    if (i === this.s.index) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
      this.set({ queue, index: -1, playing: false });
      if (queue.length > 0) this.playIndex(Math.min(i, queue.length - 1));
    } else {
      this.set({ queue, index: i < this.s.index ? this.s.index - 1 : this.s.index });
    }
    URL.revokeObjectURL(removed.url);
  }

  /** Release the microphone, camera, audio graph and any loaded files. */
  stop() {
    if (this.disposed) return;
    this.el.pause();
    this.el.removeAttribute("src");
    for (const track of this.s.queue) URL.revokeObjectURL(track.url);
    this.raw.getTracks().forEach((track) => track.stop());
    this.out.getTracks().forEach((track) => track.stop());
    void this.ctx?.close().catch(() => {});
    this.disposed = true;
    this.listeners.clear();
  }
}
