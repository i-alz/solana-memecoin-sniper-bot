import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIORITY_FEE = parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '100000');

export const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

/**
 * Get SOL balance of a wallet in SOL (not lamports).
 */
export async function getSolBalance(publicKey: string): Promise<number> {
  const pubkey = new PublicKey(publicKey);
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Get token balance for a specific mint in a wallet.
 */
export async function getTokenBalance(
  walletPubkey: string,
  tokenMint: string
): Promise<number> {
  try {
    const wallet = new PublicKey(walletPubkey);
    const mint = new PublicKey(tokenMint);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length === 0) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

/**
 * Send a pre-built versioned or legacy transaction.
 * Adds priority fee instructions before signing.
 */
export async function sendTransaction(
  transaction: Transaction,
  signers: Keypair[]
): Promise<string> {
  // Add priority fee
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, transaction, signers, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  return sig;
}

/**
 * Send a VersionedTransaction (used by Jupiter/Photon swaps).
 */
export async function sendVersionedTransaction(
  vtx: VersionedTransaction,
  signer: Keypair
): Promise<string> {
  vtx.sign([signer]);
  const sig = await connection.sendTransaction(vtx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/**
 * Fetch recent blockhash.
 */
export async function getRecentBlockhash(): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();
  return blockhash;
}

/**
 * Check if a transaction was successful.
 */
export async function isTransactionSuccessful(signature: string): Promise<boolean> {
  const status = await connection.getSignatureStatus(signature);
  return status?.value?.err === null;
}

/**
 * Get token price in SOL from on-chain data via Helius or Jupiter price API.
 */
export async function getTokenPriceInSol(tokenMint: string): Promise<number | null> {
  try {
    const axios = (await import('axios')).default;
    // Use Jupiter price API for fast pricing
    const resp = await axios.get(
      `https://price.jup.ag/v6/price?ids=${tokenMint}&vsToken=So11111111111111111111111111111111111111112`,
      { timeout: 5000 }
    );
    const data = resp.data?.data?.[tokenMint];
    return data?.price ?? null;
  } catch {
    return null;
  }
}

/**
 * Stream new Raydium/Pump.fun pool events via Helius webhook or websocket.
 * Returns an EventEmitter-like interface.
 */
export function listenForNewPools(
  onPool: (pool: {
    programId: string;
    poolId: string;
    baseMint: string;
    quoteMint: string;
    baseVault: string;
    quoteVault: string;
    liquiditySol: number;
  }) => void
): () => void {
  const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymGN55';

  // Subscribe to logs mentioning Raydium AMM (new pool init)
  const raydiumSub = connection.onLogs(
    new PublicKey(RAYDIUM_AMM_PROGRAM),
    async (logs) => {
      if (!logs.logs.some(l => l.includes('InitializeInstruction2') || l.includes('initialize2'))) return;
      try {
        const tx = await connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta?.postTokenBalances) return;

        const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const baseVault = accounts[4];
        const quoteVault = accounts[5];
        const baseMint = accounts[8];
        const quoteMint = accounts[9];
        const poolId = accounts[4] ?? logs.signature;

        // Estimate SOL liquidity from pre/post balances
        const solDelta = tx.meta.postBalances[6] - tx.meta.preBalances[6];
        const liquiditySol = Math.abs(solDelta) / LAMPORTS_PER_SOL;

        onPool({
          programId: RAYDIUM_AMM_PROGRAM,
          poolId,
          baseMint,
          quoteMint,
          baseVault,
          quoteVault,
          liquiditySol,
        });
      } catch { /* ignore parse errors */ }
    },
    'confirmed'
  );

  // Subscribe to Pump.fun (new mints)
  const pumpSub = connection.onLogs(
    new PublicKey(PUMP_FUN_PROGRAM),
    async (logs) => {
      if (!logs.logs.some(l => l.includes('MintTo') || l.includes('create'))) return;
      try {
        const tx = await connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) return;
        const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const baseMint = accounts[0];
        const liquiditySol = (tx.meta?.postBalances?.[0] ?? 0) / LAMPORTS_PER_SOL;
        onPool({
          programId: PUMP_FUN_PROGRAM,
          poolId: logs.signature,
          baseMint,
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseVault: accounts[1] ?? '',
          quoteVault: accounts[2] ?? '',
          liquiditySol,
        });
      } catch { /* ignore */ }
    },
    'confirmed'
  );

  // Return cleanup function
  return () => {
    connection.removeOnLogsListener(raydiumSub);
    connection.removeOnLogsListener(pumpSub);
  };
}
