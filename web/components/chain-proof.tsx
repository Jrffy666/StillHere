'use client';
import { useMemo, useState } from 'react';
import { useSessionValue } from '@/lib/session-storage';
import { Connection, PublicKey, type Transaction } from '@solana/web3.js';
import {
  Wallet,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  Copy,
  Leaf,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  SafetyGuardClient,
  randomTripId,
  tripIdFromHex,
  tripIdToHex,
  deriveTaskAddress,
  type GuardTask,
} from '@/lib/chain-client';
import { errorMessage } from '@/lib/api';
import type { Trip } from '@/lib/types';

export interface ChainConfig {
  configured: boolean;
  programId: string | null;
  rpcUrl: string;
  network: string;
}
interface WalletProvider {
  publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
}
interface Reference {
  rider: string;
  guardian: string;
  tripId: string;
}
function provider(): WalletProvider {
  const walletWindow = window as Window & {
    phantom?: { solana?: WalletProvider };
    solana?: WalletProvider;
  };
  const wallet = walletWindow.phantom?.solana || walletWindow.solana;
  if (!wallet?.connect || !wallet.signTransaction)
    throw new Error(
      'Install a Solana browser wallet such as Phantom and switch it to Devnet. Your private keys stay in your wallet.',
    );
  return wallet;
}
export function ChainProof({
  trip,
  config,
  open,
  onOpenChange,
}: {
  trip: Trip;
  config?: ChainConfig;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [wallet, setWallet] = useState('');
  const [rawRef, setRawRef] = useSessionValue(`guard:chain:${trip.id}`);
  const ref = useMemo((): Reference => {
    try {
      const saved = JSON.parse(rawRef || 'null') as Reference | null;
      if (
        saved &&
        typeof saved.rider === 'string' &&
        typeof saved.guardian === 'string' &&
        typeof saved.tripId === 'string'
      )
        return saved;
    } catch {
      /* An invalid local reference can be replaced in the form. */
    }
    return { rider: '', guardian: '', tripId: '' };
  }, [rawRef]);
  const [task, setTask] = useState<GuardTask | null>(null),
    [points, setPoints] = useState<string | null>(null),
    [signature, setSignature] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  function save(value: Reference) {
    setRawRef(JSON.stringify(value));
    setTask(null);
    setPoints(null);
  }
  async function client() {
    if (!config?.configured || !config.programId)
      throw new Error(
        'The Solana program has not been configured. Community check-ins still work without it.',
      );
    const url = new URL(config.rpcUrl);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local)
      throw new Error('The Solana RPC must use HTTPS.');
    const connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    });
    const genesis = await connection.getGenesisHash();
    // Solana's documented CAIP-2 devnet identifier is the first 32 genesis-hash characters.
    if (!local && !genesis.startsWith('EtWTRABZaYq6iMfeYKouRu166VU2xqa1'))
      throw new Error(
        'This app only signs Devnet or local test-validator transactions.',
      );
    const sdk = new SafetyGuardClient(
      connection,
      new PublicKey(config.programId),
    );
    if (!(await sdk.isProgramDeployed()))
      throw new Error(
        'No executable Safety Guard program was found at the configured address.',
      );
    return sdk;
  }
  async function connect() {
    setBusy(true);
    setMessage('');
    try {
      const result = await provider().connect();
      setWallet(result.publicKey.toBase58());
      if (!ref.rider) save({ ...ref, rider: result.publicKey.toBase58() });
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function read(sdk: SafetyGuardClient, reference: Reference) {
    const data = await sdk.fetchTask({
      rider: new PublicKey(reference.rider),
      tripId: tripIdFromHex(reference.tripId),
    });
    setTask(data);
    if (data) {
      const rep = await sdk.fetchReputation(data.guardian);
      setPoints(rep?.points.toString() ?? '0');
    } else setMessage('No on-chain task was found for this reference.');
  }
  async function refresh() {
    setBusy(true);
    setMessage('');
    try {
      await read(await client(), ref);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function transact(
    action: 'create' | 'accept' | 'check-in' | 'complete' | 'cancel',
  ) {
    setBusy(true);
    setMessage('');
    try {
      const sdk = await client(),
        walletProvider = provider();
      const connected = await walletProvider.connect();
      setWallet(connected.publicKey.toBase58());
      const reference =
        action === 'create'
          ? {
              ...ref,
              rider: connected.publicKey.toBase58(),
              tripId: ref.tripId || tripIdToHex(randomTripId()),
            }
          : ref;
      const input = {
        rider: new PublicKey(reference.rider),
        guardian: new PublicKey(reference.guardian),
        tripId: tripIdFromHex(reference.tripId),
      };
      const expected =
        action === 'accept' || action === 'check-in'
          ? input.guardian
          : input.rider;
      if (!connected.publicKey.equals(expected))
        throw new Error(
          `Connect the ${action === 'accept' || action === 'check-in' ? 'guardian' : 'rider'} wallet for this action.`,
        );
      const tx =
        action === 'create'
          ? sdk.createTask({
              ...input,
              deadline: Math.floor(Date.now() / 1000) + 21600,
            })
          : action === 'accept'
            ? sdk.acceptTask(input)
            : action === 'check-in'
              ? sdk.checkIn(input)
              : action === 'complete'
                ? sdk.completeTask(input)
                : sdk.cancelTask(input);
      save(reference); // Keep public recovery coordinates even if confirmation later times out.
      const prepared = await sdk.prepareTransaction(tx, connected.publicKey);
      const signed = await walletProvider.signTransaction(prepared.transaction);
      const sig = await sdk.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });
      setSignature(sig);
      const result = await sdk.connection.confirmTransaction(
        {
          signature: sig,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
        'confirmed',
      );
      if (result.value.err)
        throw new Error(
          'The transaction failed on chain. No success is being recorded.',
        );
      await read(sdk, reference);
      setMessage(
        'Transaction confirmed. The account state below was read from Solana.',
      );
    } catch (e) {
      setMessage(
        `${errorMessage(e)} If a signature is shown, check it before submitting again.`,
      );
    } finally {
      setBusy(false);
    }
  }
  const active = task?.state === 'active';
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="journey-dialog proof-dialog">
        <DialogHeader>
          <span className="dialog-icon">
            <Leaf size={22} />
          </span>
          <DialogTitle>A little care, recognized.</DialogTitle>
          <DialogDescription>
            Community contributions and optional Solana test-network receipts.
          </DialogDescription>
        </DialogHeader>
        <div className="reward-preview">
          <div>
            <span>COMMUNITY POINTS</span>
            <strong>
              {trip.reward.status === 'credited' ? trip.reward.points : 0}
            </strong>
          </div>
          <div>
            <span>REPUTATION</span>
            <strong>
              {trip.reward.status === 'credited' ? trip.reward.reputation : 0}
            </strong>
          </div>
          <span className="status-pill">{trip.reward.status}</span>
        </div>
        <p className="field-hint">
          These are app records.{' '}
          {trip.demo
            ? 'Demo journeys issue no real points.'
            : 'A guardian needs an eligible check-in and rider-confirmed arrival.'}{' '}
          They are not blockchain transactions.
        </p>
        <div className="proof-heading">
          <ShieldCheck size={18} />
          <h3>Solana contribution receipt</h3>
          <span className="mini-tag">TEST NETWORK</span>
        </div>
        {!config?.configured ? (
          <div className="connection-empty">
            <Wallet size={27} />
            <strong>Solana is not connected yet</strong>
            <p>
              The contract and wallet integration are included. A deployed
              test-network program is needed before receipts can be recorded on
              chain.
            </p>
            <span>
              Your journey features remain available without a wallet.
            </span>
          </div>
        ) : (
          <>
            <p className="field-hint">
              This is a separate signed workflow. A confirmed task awards 10
              non-transferable chain points; it does not verify real-world
              safety or your app identity. Devnet SOL has no real value.
            </p>
            <Button
              variant="outline"
              onClick={() => void connect()}
              disabled={busy}
            >
              <Wallet size={15} />
              {wallet
                ? `${wallet.slice(0, 7)}…${wallet.slice(-5)}`
                : 'Connect test wallet'}
            </Button>
            <label className="field-label" htmlFor="chain-rider">
              Rider wallet
            </label>
            <Input
              id="chain-rider"
              value={ref.rider}
              onChange={(e) => save({ ...ref, rider: e.target.value })}
              placeholder="Rider public key"
            />
            <label className="field-label" htmlFor="chain-guardian">
              Guardian wallet
            </label>
            <Input
              id="chain-guardian"
              value={ref.guardian}
              onChange={(e) => save({ ...ref, guardian: e.target.value })}
              placeholder="A different guardian public key"
            />
            <label className="field-label" htmlFor="chain-reference">
              Receipt reference <span>generated on creation</span>
            </label>
            <Input
              id="chain-reference"
              value={ref.tripId}
              onChange={(e) => save({ ...ref, tripId: e.target.value })}
              placeholder="64-character public reference"
            />
            <div className="proof-actions">
              <Button
                disabled={busy || !ref.guardian || !wallet}
                onClick={() => void transact('create')}
              >
                Create receipt
              </Button>
              <Button
                variant="outline"
                disabled={busy || !ref.tripId || !ref.rider}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                Read chain state
              </Button>
              <Button
                variant="ghost"
                disabled={!ref.tripId}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(JSON.stringify(ref))
                    .then(() =>
                      setMessage(
                        'Public reference copied. Share its three fields with your guardian.',
                      ),
                    )
                    .catch(() =>
                      setMessage(
                        'Copy was unavailable. Share the public fields manually.',
                      ),
                    )
                }
              >
                <Copy size={14} />
                Copy reference
              </Button>
            </div>
            {task && (
              <div className="chain-state">
                <strong>Confirmed account: {task.state}</strong>
                <span>Signed guardian check-ins: {task.checkInCount}</span>
                <span>Guardian chain points across tasks: {points ?? '—'}</span>
                <code>
                  {deriveTaskAddress(
                    task.rider,
                    task.tripId,
                    new PublicKey(config.programId!),
                  ).toBase58()}
                </code>
                <div className="proof-actions">
                  {task.state === 'pending' && (
                    <Button
                      disabled={busy}
                      onClick={() => void transact('accept')}
                    >
                      Guardian: accept
                    </Button>
                  )}
                  {active && (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() => void transact('check-in')}
                      >
                        Guardian: check in
                      </Button>
                      <Button
                        disabled={busy || task.checkInCount < 1}
                        onClick={() => void transact('complete')}
                      >
                        Rider: confirm completion
                      </Button>
                    </>
                  )}
                  {(active || task.state === 'pending') && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void transact('cancel')}
                    >
                      Rider: cancel
                    </Button>
                  )}
                </div>
              </div>
            )}
            {signature && (
              <a
                className="text-action"
                target="_blank"
                rel="noopener noreferrer"
                href={`https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`}
              >
                View submitted transaction <ExternalLink size={13} />
              </a>
            )}
          </>
        )}
        {message && <output className="notice">{message}</output>}
      </DialogContent>
    </Dialog>
  );
}
