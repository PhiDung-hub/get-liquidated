import { DOMAIN_FIELDS, ZERO_ADDRESS, digest, domainSeparator, hashStruct, type Field } from './eip712';

export const APPROVE_AGENT_FIELDS: Field[] = [
  { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' },
  { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }
];

export type ApproveAgentAction = {
  type: 'approveAgent';
  hyperliquidChain: 'Mainnet' | 'Testnet';
  signatureChainId: string;
  agentAddress: string;
  agentName: string;
  nonce: number;
};

const domainFor = (signatureChainId: string) => ({
  name: 'HyperliquidSignTransaction', version: '1', chainId: BigInt(signatureChainId), verifyingContract: ZERO_ADDRESS
});

export const userSignedDigest = (primaryType: string, fields: Field[], action: Record<string, unknown> & { signatureChainId: string }) =>
  digest(domainSeparator(domainFor(action.signatureChainId)), hashStruct(primaryType, fields, action));

/** Payload for eth_signTypedData_v4; chainId must equal the wallet's active chain. */
export function approveAgentTypedData(a: ApproveAgentAction) {
  return {
    domain: { ...domainFor(a.signatureChainId), chainId: Number(BigInt(a.signatureChainId)) },
    types: { EIP712Domain: DOMAIN_FIELDS, 'HyperliquidTransaction:ApproveAgent': APPROVE_AGENT_FIELDS },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: a.hyperliquidChain, agentAddress: a.agentAddress, agentName: a.agentName, nonce: a.nonce }
  };
}
