import { PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { api } from './api';
import type { Session } from './types';

interface WalletProvider {
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect?(): Promise<void>;
  signMessage(
    message: Uint8Array,
    display?: string,
  ): Promise<{ signature: Uint8Array } | Uint8Array>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}
export async function connectWallet(): Promise<WalletProvider> {
  const host = window as unknown as {
    phantom?: { solana?: WalletProvider };
    solflare?: WalletProvider;
    solana?: WalletProvider;
  };
  const wallet = host.phantom?.solana || host.solflare || host.solana;
  if (!wallet?.signMessage || !wallet.signTransaction)
    throw new Error(
      'Open this page in a Solana wallet browser, or enable Phantom or Solflare.',
    );
  await wallet.connect();
  if (!wallet.publicKey)
    throw new Error('The wallet did not provide an address.');
  return wallet;
}
export type IdentityIntent =
  | 'bind'
  | 'login'
  | 'rotate'
  | 'recover'
  | 'recovery-code'
  | 'revoke-sessions';
export async function walletIdentity(
  intent: IdentityIntent,
  token?: string,
  options: { accountId?: string; recoveryCode?: string } = {},
): Promise<Session & { recoveryCode?: string }> {
  const wallet = await connectWallet();
  const address = wallet.publicKey!.toBase58();
  const challenge = await api<{
    id: string;
    message: string;
    expiresAt: number;
    domain: string;
    wallet: string;
    intent: string;
  }>('/auth/challenge', token, {
    intent,
    wallet: address,
    ...(options.accountId ? { accountId: options.accountId } : {}),
  });
  if (
    challenge.domain !== window.location.origin ||
    challenge.wallet !== address ||
    challenge.intent !== intent ||
    challenge.expiresAt <= Date.now() ||
    !challenge.message.includes(challenge.domain) ||
    !challenge.message.includes(address)
  )
    throw new Error('The sign-in request does not match this site and wallet.');
  const signed = await wallet.signMessage(
    new TextEncoder().encode(challenge.message),
    'utf8',
  );
  const signature = Buffer.from(
    signed instanceof Uint8Array ? signed : signed.signature,
  ).toString('base64');
  return api('/auth/verify', token, {
    challengeId: challenge.id,
    signature,
    ...(options.recoveryCode
      ? { recoveryCode: options.recoveryCode.trim() }
      : {}),
  });
}
export async function signJourneyTransaction(
  encoded: string,
  address: string,
): Promise<string> {
  const wallet = await connectWallet();
  if (wallet.publicKey!.toBase58() !== address)
    throw new Error(
      `Switch your wallet to ${address}. This action requires that signing wallet.`,
    );
  const transaction = Transaction.from(Buffer.from(encoded, 'base64'));
  const message = Buffer.from(transaction.serializeMessage()).toString(
    'base64',
  );
  const signed = await wallet.signTransaction(transaction);
  if (
    Buffer.from(signed.serializeMessage()).toString('base64') !== message ||
    !signed.verifySignatures()
  )
    throw new Error('The wallet returned a changed or incomplete transaction.');
  return Buffer.from(signed.serialize()).toString('base64');
}
