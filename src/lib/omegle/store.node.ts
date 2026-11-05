/** JSON-file store for the Node / Termux server. Saved a moment after each change. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore } from "./store.ts";

export class FileStore extends MemoryStore {
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly file: string;

  constructor(file: string) {
    super();
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) this.data.set(k, v);
    } catch {
      /* first run, or unreadable: start empty */
    }
  }

  protected override changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 500);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)));
      renameSync(tmp, this.file);
    } catch (error) {
      console.error("[omegle] could not save data:", error);
    }
  }
}
