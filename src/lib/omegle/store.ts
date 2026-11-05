/**
 * Tiny key-value storage the accounts and usage records live in.
 * Cloudflare: the Durable Object's own storage. Termux/Node: a JSON file.
 * Tests: plain memory.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix`. */
  list<T>(prefix: string): Promise<Array<[string, T]>>;
}

export class MemoryStore implements Store {
  protected data = new Map<string, unknown>();
  /** Called after every change (the file store uses it to save). */
  protected changed(): void {}

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
    this.changed();
  }
  async delete(key: string): Promise<void> {
    if (this.data.delete(key)) this.changed();
  }
  async list<T>(prefix: string): Promise<Array<[string, T]>> {
    const out: Array<[string, T]> = [];
    for (const [k, v] of this.data) if (k.startsWith(prefix)) out.push([k, structuredClone(v) as T]);
    return out;
  }
}
