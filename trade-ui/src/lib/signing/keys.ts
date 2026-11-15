import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export type Signature = { r: string; s: string; v: number };

const h64 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

// noble v2 re-hashes input unless prehash:false — that would sign the wrong digest.
export function signDigest(digest: Uint8Array, key: Uint8Array): Signature {
  const raw = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
  const sig = secp256k1.Signature.fromBytes(raw, 'recovered');
  return { r: h64(sig.r), s: h64(sig.s), v: 27 + sig.recovery! };
}

export const newKey = () => secp256k1.utils.randomSecretKey();
export const hexToKey = (hex: string) => hexToBytes(hex.replace(/^0x/, ''));
export const keyToHex = (key: Uint8Array) => '0x' + bytesToHex(key);
export const addressOf = (key: Uint8Array) =>
  '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(12));

/** Wallet eth_signTypedData_v4 returns r||s||v; some signers report v as 0/1. */
export function parseWalletSignature(hex: string): Signature {
  const h = hex.replace(/^0x/, '');
  if (h.length !== 130) throw new Error(`wallet signature has ${h.length / 2} bytes, expected 65`);
  const v = parseInt(h.slice(128, 130), 16);
  return { r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128), v: v < 27 ? v + 27 : v };
}
