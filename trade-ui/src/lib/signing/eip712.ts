import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export type Field = { name: string; type: string };
export type Domain = { name: string; version: string; chainId: number | bigint; verifyingContract: string };
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DOMAIN_FIELDS: Field[] = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }
];

const word = (n: number | bigint | boolean) => {
  const b = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const strip = (h: string) => h.replace(/^0x/, '');

function encodeField(type: string, value: unknown): Uint8Array {
  if (type === 'string') return keccak_256(utf8ToBytes(String(value)));
  if (type === 'bytes32') {
    const b = typeof value === 'string' ? hexToBytes(strip(value)) : (value as Uint8Array);
    if (b.length !== 32) throw new Error('eip712: bytes32 must be 32 bytes');
    return b;
  }
  if (type === 'address') {
    const b = new Uint8Array(32);
    b.set(hexToBytes(strip(String(value)).toLowerCase()), 12);
    return b;
  }
  if (type === 'bool') return word(value as boolean);
  if (/^uint\d+$/.test(type)) return word(value as number | bigint);
  throw new Error(`eip712: unsupported field type ${type}`);
}

const typeString = (name: string, fields: Field[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;

export const hashStruct = (name: string, fields: Field[], msg: Record<string, unknown>) =>
  keccak_256(concatBytes(keccak_256(utf8ToBytes(typeString(name, fields))), ...fields.map((f) => encodeField(f.type, msg[f.name]))));

export const domainSeparator = (d: Domain) => hashStruct('EIP712Domain', DOMAIN_FIELDS, d);

export const digest = (domainSep: Uint8Array, structHash: Uint8Array) =>
  keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domainSep, structHash));
