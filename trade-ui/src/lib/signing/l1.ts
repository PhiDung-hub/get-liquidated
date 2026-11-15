import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { pack } from './msgpack';
import { digest, domainSeparator, ZERO_ADDRESS } from './eip712';

const EXCHANGE_DOMAIN = domainSeparator({ name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS });
// hashStruct('Agent', [source: string, connectionId: bytes32]) with its constant parts hashed once.
const AGENT_TYPEHASH = keccak_256(utf8ToBytes('Agent(string source,bytes32 connectionId)'));
const SOURCE = { mainnet: keccak_256(utf8ToBytes('a')), testnet: keccak_256(utf8ToBytes('b')) };

const u64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

export function actionHash(action: object, vault: string | null, nonce: number, expiresAfter: number | null): Uint8Array {
  const parts = [pack(action), u64(nonce)];
  parts.push(vault == null ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), hexToBytes(vault.replace(/^0x/, '').toLowerCase())));
  if (expiresAfter != null) parts.push(Uint8Array.of(0), u64(expiresAfter));
  return keccak_256(concatBytes(...parts));
}

export function l1Digest(action: object, nonce: number, isMainnet: boolean, expiresAfter: number | null = null, vault: string | null = null): Uint8Array {
  const connectionId = actionHash(action, vault, nonce, expiresAfter);
  return digest(EXCHANGE_DOMAIN, keccak_256(concatBytes(AGENT_TYPEHASH, isMainnet ? SOURCE.mainnet : SOURCE.testnet, connectionId)));
}
