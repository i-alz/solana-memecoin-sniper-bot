/**
 * photonClient.ts
 *
 * Trading execution layer that integrates with Photon (https://photon-sol.tinyastro.io)
 * and falls back to Jupiter Aggregator for token swaps on Solana.
 *
 * Photon provides:
 * - Fast, low-latency order routing
 * - Anti-rug / honeypot filters
 * - Real-time holder and liquidity data
 *
 * This client:
 * 1. Attempts to use Photon API for buy/sell orders.
 * 2. Falls back to Jupiter V6 swap API if Photon is unavailable.
 */

import axios from 'axios';
import { Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import { connection, sendVersionedTransaction } from './solanaClient';
import dotenv from 'dotenv';

dotenv.config();

const PHOTON_API_URL = process.env.PHOTON_API_URL || 'https://api.photon-sol.tinyastro.io';
const PHOTON_API_KEY = process.env.PHOTON_API_KEY || '';
const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6';
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || '500');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SwapResult {
  signature: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  source: 'photon' | 'jupiter';
}

/**
 * Buy a token using SOL.
 * @param keypair  Signer wallet
 * @param tokenMint  Token mint address to buy
 * @param amountSol  Amount of SOL to spend
 */
export async function buyToken(
  keypair: Keypair,
  tokenMint: string,
  amountSol: number
): Promise<SwapResult> {
  const amountLamports = Math.floor(amountSol * 1e9);

  // Try Photon first
  if (PHOTON_API_KEY) {
    try {
      return await photonSwap(keypair, SOL_MINT, tokenMint, amountLamports);
    } catch (err: any) {
      console.warn('[Photon] Buy failed, falling back to Jupiter:', err.message);
    }
  }

  // Fall back to Jupiter
  return await jupiterSwap(keypair, SOL_MINT, tokenMint, amountLamports);
}

/**
 * Sell all tokens for SOL.
 * @param keypair  Signer wallet
 * @param tokenMint  Token mint address to sell
 * @param tokenAmount  Amount of tokens to sell (human-readable)
 * @param tokenDecimals  Token decimal places (default 6 for most memecoins)
 */
export async function sellToken(
  keypair: Keypair,
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals = 6
): Promise<SwapResult> {
  const rawAmount = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));

  // Try Photon first
  if (PHOTON_API_KEY) {
    try {
      return await photonSwap(keypair, tokenMint, SOL_MINT, rawAmount);
    } catch (err: any) {
      console.warn('[Photon] Sell failed, falling back to Jupiter:', err.message);
    }
  }

  // Fall back to Jupiter
  return await jupiterSwap(keypair, tokenMint, SOL_MINT, rawAmount);
}

// ---- Photon swap implementation ----
async function photonSwap(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<SwapResult> {
  const walletPubkey = keypair.publicKey.toBase58();

  // 1. Get a swap transaction from Photon
  const resp = await axios.post(
    `${PHOTON_API_URL}/v1/swap`,
    {
      inputMint,
      outputMint,
      amount,
      slippageBps: MAX_SLIPPAGE_BPS,
      userPublicKey: walletPubkey,
    },
    {
      headers: {
        'X-API-Key': PHOTON_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  const { swapTransaction, inputAmount, outputAmount, priceImpactPct } = resp.data;

  // 2. Deserialize and sign the transaction
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuf);

  // 3. Send
  const signature = await sendVersionedTransaction(vtx, keypair);

  return {
    signature,
    inputMint,
    outputMint,
    inputAmount: inputAmount / 1e9,
    outputAmount,
    priceImpactPct,
    source: 'photon',
  };
}

// ---- Jupiter swap implementation ----
async function jupiterSwap(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<SwapResult> {
  const walletPubkey = keypair.publicKey.toBase58();

  // 1. Get best route quote
  const quoteResp = await axios.get(`${JUPITER_API_URL}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount,
      slippageBps: MAX_SLIPPAGE_BPS,
      onlyDirectRoutes: false,
    },
    timeout: 10000,
  });

  const quote = quoteResp.data;

  // 2. Get swap transaction
  const swapResp = await axios.post(
    `${JUPITER_API_URL}/swap`,
    {
      quoteResponse: quote,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
    { timeout: 15000 }
  );

  const { swapTransaction } = swapResp.data;

  // 3. Deserialize and sign
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuf);

  const signature = await sendVersionedTransaction(vtx, keypair);

  return {
    signature,
    inputMint,
    outputMint,
    inputAmount: amount / 1e9,
    outputAmount: parseInt(quote.outAmount),
    priceImpactPct: parseFloat(quote.priceImpactPct),
    source: 'jupiter',
  };
}

/**
 * Get a quick price estimate for a token vs SOL using Jupiter.
 * Returns price in SOL per 1 token.
 */
export async function getQuickPrice(tokenMint: string): Promise<number | null> {
  try {
    const resp = await axios.get(`${JUPITER_API_URL}/quote`, {
      params: {
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: 1_000_000, // 1 token (6 decimals)
        slippageBps: MAX_SLIPPAGE_BPS,
        onlyDirectRoutes: true,
      },
      timeout: 5000,
    });
    const outAmount = parseInt(resp.data.outAmount);
    return outAmount / 1e9; // convert lamports to SOL
  } catch {
    return null;
  }
}

/**
 * Fetch token metadata from Photon (holders, liquidity, age).
 */
export async function getPhotonTokenInfo(tokenMint: string): Promise<{
  symbol?: string;
  name?: string;
  liquiditySol?: number;
  holders?: number;
  marketCapSol?: number;
  ageSeconds?: number;
  isHoneypot?: boolean;
} | null> {
  if (!PHOTON_API_KEY) return null;
  try {
    const resp = await axios.get(`${PHOTON_API_URL}/v1/token/${tokenMint}`, {
      headers: { 'X-API-Key': PHOTON_API_KEY },
      timeout: 5000,
    });
    const d = resp.data;
    return {
      symbol: d.symbol,
      name: d.name,
      liquiditySol: d.liquidity_sol,
      holders: d.holder_count,
      marketCapSol: d.market_cap_sol,
      ageSeconds: d.age_seconds,
      isHoneypot: d.is_honeypot ?? false,
    };
  } catch {
    return null;
  }
}
