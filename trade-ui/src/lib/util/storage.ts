export function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`storage: could not save ${key}`, e);
  }
}

/** A value saved with keep() under `key`, or null once it is older than `ttl` ms (or from the future). */
export function fresh<T>(key: string, ttl: number): T | null {
  const c = load<{ at?: unknown; v?: T } | null>(key, null);
  const age = Date.now() - Number(c?.at);
  return age >= 0 && age < ttl ? (c!.v ?? null) : null;
}
export const keep = (key: string, v: unknown) => save(key, { at: Date.now(), v });

// One store, version 1, for fills and candles (keys `candles:…`): a new version would wait on every tab still open on the old one.
let db: Promise<IDBDatabase> | undefined;
const openDb = () =>
  (db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('trade-ui', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fills');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));

async function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const tx = (await openDb()).transaction('fills', mode);
  const r = run(tx.objectStore('fills'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? r.error);
  });
}

const idbGet = (key: string) => request<unknown>('readonly', (s) => s.get(key));
export const idbGetWithin = (key: string, ms: number) => Promise.race([idbGet(key), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
export const idbPut = (key: string, value: unknown) => request<void>('readwrite', (s) => s.put(value, key));
export const idbDelete = (key: string) => request<void>('readwrite', (s) => s.delete(key));

export function rememberKey(listKey: string, key: string, max: number, drop: (k: string) => void) {
  const keys = load<unknown>(listKey, []);
  if (Array.isArray(keys) && keys[0] === key) return;
  const next = [key, ...(Array.isArray(keys) ? keys : []).filter((k) => k !== key)];
  next.slice(max).forEach((k) => drop(String(k)));
  save(listKey, next.slice(0, max));
}
