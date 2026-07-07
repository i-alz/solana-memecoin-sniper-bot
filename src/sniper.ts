/**
 * sniper.ts
 *
 * Launch Sniper: listens for new Raydium / Pump.fun pools and
 * automatically buys tokens that pass configurable filters.
 *
 * Filters applied before each snipe:
 *  - Minimum liquidity in SOL
 *  - Daily loss cap check (stops sniping if limit reached)
 *  - Max open positions check
 *  - Honeypot check via Photon (if API key set)
 *
 * After buying, a take-profit / stop-loss monitor runs every 30s.
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from './logger';
import { listenForNewPools } from './solanaClient';
import { buyToken, sellToken, getPhotonTokenInfo } from './photonClient';
import {
  getRiskConfig,
  getTodayLossSol,
  addOpenPosition,
  removeOpenPosition,
  getOpenPositions,
  recordTrade,
} from './db';
import { getActiveKeypair } from './walletManager';
import { getQuickPrice } from './photonClient';

const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_POOL_LIQUIDITY_SOL || '10');

// Internal state
let sniperActive = false;
let stopListening: (() => void) | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

// Track which pools we've already acted on (dedup)
const seenPools = new Set<string>();

/**
 * Start the auto-sniper for a given Telegram user.
 * @param telegramId User's Telegram ID (for wallet + risk config lookups)
 */
export function startAutoSniper(telegramId?: string): void {
  if (sniperActive) {
    logger.warn('[Sniper] Already running.');
    return;
  }
  sniperActive = true;
  logger.info('[Sniper] Auto-sniper started.');

  stopListening = listenForNewPools(async (pool) => {
    if (!sniperActive) return;
    if (seenPools.has(pool.poolId)) return;
    seenPools.add(pool.poolId);

    logger.info(
      `[Sniper] New pool detected: ${pool.baseMint} | liquidity: ${pool.liquiditySol.toFixed(2)} SOL`
    );

    // --- Filter: minimum liquidity ---
    if (pool.liquiditySol < MIN_LIQUIDITY_SOL) {
      logger.debug(
        `[Sniper] Skipping ${pool.baseMint}: liquidity ${pool.liquiditySol} < min ${MIN_LIQUIDITY_SOL}`
      );
      return;
    }

    if (!telegramId) {
      logger.warn('[Sniper] No telegramId set; cannot look up wallet or risk config.');
      return;
    }

    // --- Filter: risk config ---
    let risk;
    try {
      risk = getRiskConfig(telegramId);
    } catch {
      logger.warn(`[Sniper] No risk config for ${telegramId}; skipping snipe.`);
      return;
    }

    // --- Filter: daily loss cap ---
    const todayLoss = getTodayLossSol(telegramId);
    if (todayLoss >= risk.maxDailyLossSol) {
      logger.warn(
        `[Sniper] Daily loss cap reached (${todayLoss} / ${risk.maxDailyLossSol} SOL). Skipping.`
      );
      return;
    }

    // --- Filter: max open positions ---
    const openPositions = getOpenPositions(telegramId);
    if (openPositions.length >= risk.maxOpenPositions) {
      logger.warn(
        `[Sniper] Max open positions reached (${openPositions.length}). Skipping.`
      );
      return;
    }

    // --- Filter: honeypot check via Photon ---
    const info = await getPhotonTokenInfo(pool.baseMint);
    if (info?.isHoneypot) {
      logger.warn(`[Sniper] Honeypot detected for ${pool.baseMint}. Skipping.`);
      return;
    }

    // --- Execute snipe ---
    try {
      const keypair = getActiveKeypair(telegramId);
      const amountSol = risk.positionSizeSol;

      logger.info(
        `[Sniper] Sniping ${pool.baseMint} with ${amountSol} SOL...`
      );

      const result = await buyToken(keypair, pool.baseMint, amountSol);

      logger.info(
        `[Sniper] Bought ${pool.baseMint} | tx: ${result.signature} | source: ${result.source}`
      );

      // Record in DB
      addOpenPosition(telegramId, {
        tokenMint: pool.baseMint,
        entryPriceSol: result.inputAmount / (result.outputAmount || 1),
        tokenAmount: result.outputAmount,
        amountSol,
        signature: result.signature,
      });

    } catch (err: any) {
      logger.error(`[Sniper] Failed to snipe ${pool.baseMint}:`, err.message);
    }
  });

  // --- Start position monitor ---
  monitorInterval = setInterval(() => {
    if (telegramId) monitorPositions(telegramId);
  }, 30_000);
}

/**
 * Stop the auto-sniper.
 */
export function stopAutoSniper(): void {
  if (!sniperActive) return;
  sniperActive = false;

  if (stopListening) {
    stopListening();
    stopListening = null;
  }
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  logger.info('[Sniper] Auto-sniper stopped.');
}

export function isSniperActive(): boolean {
  return sniperActive;
}

/**
 * Monitor open positions for take-profit / stop-loss.
 */
async function monitorPositions(telegramId: string): Promise<void> {
  const positions = getOpenPositions(telegramId);
  if (positions.length === 0) return;

  let risk;
  try {
    risk = getRiskConfig(telegramId);
  } catch {
    return;
  }

  for (const pos of positions) {
    try {
      const currentPrice = await getQuickPrice(pos.tokenMint);
      if (!currentPrice) continue;

      const pnlPct =
        ((currentPrice - pos.entryPriceSol) / pos.entryPriceSol) * 100;

      logger.debug(
        `[Monitor] ${pos.tokenMint} | PnL: ${pnlPct.toFixed(1)}% | TP: ${risk.takeProfitPct}% | SL: ${risk.stopLossPct}%`
      );

      const shouldSell =
        pnlPct >= risk.takeProfitPct || pnlPct <= -risk.stopLossPct;

      if (shouldSell) {
        const reason = pnlPct >= risk.takeProfitPct ? 'TAKE_PROFIT' : 'STOP_LOSS';
        logger.info(
          `[Monitor] ${reason} triggered for ${pos.tokenMint} at ${pnlPct.toFixed(1)}%`
        );

        const keypair = getActiveKeypair(telegramId);
        const result = await sellToken(keypair, pos.tokenMint, pos.tokenAmount);

        logger.info(
          `[Monitor] Sold ${pos.tokenMint} | tx: ${result.signature}`
        );

        const pnlSol =
          result.outputAmount / 1e9 - pos.amountSol;

        recordTrade(telegramId, {
          tokenMint: pos.tokenMint,
          action: 'sell',
          amountSol: pos.amountSol,
          pnlSol,
          reason,
          signature: result.signature,
        });

        removeOpenPosition(telegramId, pos.tokenMint);
      }
    } catch (err: any) {
      logger.error(`[Monitor] Error checking position ${pos.tokenMint}:`, err.message);
    }
  }
}
