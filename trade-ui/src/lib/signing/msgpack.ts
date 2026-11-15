/** Subset of msgpack matching python msgpack.packb defaults; map keys keep insertion order. */
export function pack(value: unknown): Uint8Array {
  let buf = new Uint8Array(256);
  let n = 0;
  const room = (k: number) => {
    if (n + k <= buf.length) return;
    const b = new Uint8Array(Math.max(buf.length * 2, n + k));
    b.set(buf);
    buf = b;
  };
  const u8 = (x: number) => {
    room(1);
    buf[n++] = x;
  };
  // Lengths and non-negative ints under 2^32 only; wider ints go through bigBe.
  const be = (x: number, bytes: number) => {
    room(bytes);
    for (let i = bytes - 1; i >= 0; i--) buf[n++] = (x >>> (8 * i)) & 0xff;
  };
  const bigBe = (x: bigint, bytes: number) => {
    room(bytes);
    for (let i = bytes - 1; i >= 0; i--) buf[n++] = Number((x >> BigInt(8 * i)) & 0xffn);
  };
  const head = (len: number, fix: number, fixMax: number, codes: [number, number][]) => {
    if (len < fixMax) return u8(fix | len);
    const [code, bytes] = codes.find(([, b]) => len < 2 ** (8 * b))!;
    u8(code);
    be(len, bytes);
  };
  const bigInt = (x: bigint) => {
    if (x >= 0n) {
      if (x < 128n) return u8(Number(x));
      const [code, bytes] = ([[0xcc, 1], [0xcd, 2], [0xce, 4], [0xcf, 8]] as const).find(([, b]) => x < 1n << BigInt(8 * b))!;
      u8(code);
      return bigBe(x, bytes);
    }
    if (x >= -32n) return u8(Number(x & 0xffn));
    const [code, bytes] = ([[0xd0, 1], [0xd1, 2], [0xd2, 4], [0xd3, 8]] as const).find(([, b]) => x >= -(1n << BigInt(8 * b - 1)))!;
    u8(code);
    bigBe(x & ((1n << BigInt(8 * bytes)) - 1n), bytes);
  };
  const int = (x: number) => {
    if (x >= -32 && x < 128) return u8(x & 0xff);
    if (x < 0 || x >= 0x100000000) return bigInt(BigInt(x));
    const bytes = x < 0x100 ? 1 : x < 0x10000 ? 2 : 4;
    u8(bytes === 1 ? 0xcc : bytes === 2 ? 0xcd : 0xce);
    be(x, bytes);
  };
  const str = (x: string) => {
    let ascii = true;
    for (let i = 0; i < x.length && ascii; i++) ascii = x.charCodeAt(i) < 0x80;
    const b = ascii ? null : new TextEncoder().encode(x);
    const len = b ? b.length : x.length;
    head(len, 0xa0, 32, [[0xd9, 1], [0xda, 2], [0xdb, 4]]);
    room(len);
    if (b) buf.set(b, n);
    else for (let i = 0; i < len; i++) buf[n + i] = x.charCodeAt(i);
    n += len;
  };
  const enc = (x: unknown): void => {
    if (x === null) return u8(0xc0);
    if (x === false) return u8(0xc2);
    if (x === true) return u8(0xc3);
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x)) throw new Error(`msgpack: non-integer or unsafe number ${x}`);
      return int(x);
    }
    if (typeof x === 'bigint') return bigInt(x);
    if (typeof x === 'string') return str(x);
    if (Array.isArray(x)) {
      head(x.length, 0x90, 16, [[0xdc, 2], [0xdd, 4]]);
      return x.forEach(enc);
    }
    if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) return encMap(x as Record<string, unknown>);
    throw new Error(`msgpack: unsupported ${typeof x}`);
  };
  const encMap = (o: Record<string, unknown>) => {
    const keys = Object.keys(o);
    for (const k of keys) if (o[k] === undefined) throw new Error(`msgpack: undefined at key ${k} (omit the key instead)`);
    head(keys.length, 0x80, 16, [[0xde, 2], [0xdf, 4]]);
    for (const k of keys) {
      enc(k);
      enc(o[k]);
    }
  };
  enc(value);
  return buf.slice(0, n);
}
