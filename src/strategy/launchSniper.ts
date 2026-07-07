/**
 * launchSniper.ts
 *
 * Launch sniping strategy:
 * - Listens for new Raydium / Pump.fun pool events
 * - Applies filters (min liquidity, honeypot check, etc.)
 * - Buys immediately on new pool detection
 * - Monitors price and auto-sells on take-profit or stop-loss
 */

import { listenForNewPools, getTokenPriceInSol } from '../solanaClient';
import { buyToken, sellToken, getPhotonTokenInfo, getQuickPrice } from '../photonClient';
import { getActiveKeypair, getActivePublicKey } from '../walletManager';
import {
  getRiskConfig,
  getTodayLossSol,
  addOpenPosition,
  removeOpenPosition,
  getOpenPositions,
  getAllOpenPositions,
  logTrade,
} from '../db';
import { connection } from '../solanaClient';
import { Bot } from 'grammy';

const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_POOL_LIQUIDITY_SOL || '10');

type CleanupFn = () => void;

// Map of telegram_id -> cleanup function for their snipe listener
const activeListeners = new Map<string, CleanupFn>();
// Price monitor interval
let priceMonitorInterval: NodeJS.Timeout | null = null;

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

async function notifyUser(telegramId: string, message: string): Promise<void> {
  if (botInstance) {
    try {
      await botInstance.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    } catch { /* ignore send errors */ }
  }
}

/**
 * Start launch sniping for a user.
 */
export async function startSniping(telegramId: string): Promise<void> {
  if (activeListeners.has(telegramId)) return; // already running

  const cleanup = listenForNewPools(async (pool) => {
    await handleNewPool(telegramId, pool);
  });

  activeListeners.set(telegramId, cleanup);

  // Start price monitor if not already running
  if (!priceMonitorInterval) {
    priceMonitorInterval = setInterval(() => monitorPositions(), 15_000); // every 15s
  }
}

/**
 * Stop launch sniping for a user.
 */
export async function stopSniping(telegramId: string): Promise<void> {
  const cleanup = activeListeners.get(telegramId);
  if (cleanup) {
    cleanup();
    activeListeners.delete(telegramId);
  }

  // Stop price monitor if no active listeners
  if (activeListeners.size === 0 && priceMonitorInterval) {
    clearInterval(priceMonitorInterval);
    priceMonitorInterval = null;
  }
}

/**
 * Handle a new pool event.
 */
async function handleNewPool(
  telegramId: string,
  pool: {
    programId: string;
    poolId: string;
    baseMint: string;
    quoteMint: string;
    baseVault: string;
    quoteVault: string;
    liquiditySol: number;
  }
): Promise<void> {
  try {
    const risk = getRiskConfig(telegramId);

    // --- Pre-flight checks ---

    // 1. Liquidity filter
    if (pool.liquiditySol < MIN_LIQUIDITY_SOL) return;

    // 2. Open position limit
    const openPositions = getOpenPositions(telegramId);
    if (openPositions.length >= risk.max_open_positions) return;

    // 3. Daily loss limit
    const todayLoss = getTodayLossSol(telegramId);
    if (todayLoss >= risk.max_daily_loss_sol) {
      await notifyUser(telegramId, 'Daily loss limit reached. Sniping paused for today.');
      return;
    }

    // 4. Photon metadata & honeypot check
    const tokenMint = pool.baseMint;
    const info = await getPhotonTokenInfo(tokenMint);
    if (info?.isHoneypot) {
      console.log(`[Sniper] Skipping honeypot: ${tokenMint}`);
      return;
    }

    // --- Execute buy ---
    const keypair = getActiveKeypair(telegramId);
    const amountSol = risk.position_size_sol;

    await notifyUser(
      telegramId,
      `Sniping new token!\n` +
      `Mint: <code>${tokenMint}</code>\n` +
      `Liquidity: ${pool.liquiditySol.toFixed(2)} SOL\n` +
      `Buying: ${amountSol} SOL`
    );

    const swapResult = await buyToken(keypair, tokenMint, amountSol);

    // Get entry price
    const entryPrice = await getQuickPrice(tokenMint) || 0;
    const stopLossPrice = entryPrice * (1 - risk.stop_loss_pct / 100);
    const takeProfitPrice = entryPrice * (1 + risk.take_profit_pct / 100);
    const tokensBought = swapResult.outputAmount / 1e6; // assume 6 decimals

    // Record trade and open position
    logTrade({
      telegram_id: telegramId,
      token_mint: tokenMint,
      token_symbol: info?.symbol,
      strategy: 'launch',
      side: 'buy',
      amount_sol: amountSol,
      amount_tokens: tokensBought,
      price_sol: entryPrice,
      tx_signature: swapResult.signature,
      status: 'filled',
    });

    addOpenPosition({
      telegram_id: telegramId,
      token_mint: tokenMint,
      token_symbol: info?.symbol,
      strategy: 'launch',
      entry_price_sol: entryPrice,
      amount_sol: amountSol,
      amount_tokens: tokensBought,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      buy_tx: swapResult.signature,
    });

    await notifyUser(
      telegramId,
      `Bought ${info?.symbol || tokenMint.slice(0, 8)}!\n` +
      `TX: <code>${swapResult.signature}</code>\n` +
      `Entry: ${entryPrice.toExponential(4)} SOL\n` +
      `TP: ${takeProfitPrice.toExponential(4)} SOL (+${risk.take_profit_pct}%)\n` +
      `SL: ${stopLossPrice.toExponential(4)} SOL (-${risk.stop_loss_pct}%)`
    );

  } catch (err: any) {
    console.error('[Sniper] handleNewPool error:', err.message);
  }
}

/**
 * Price monitor - checks all open positions and triggers sell if TP/SL hit.
 */
async function monitorPositions(): Promise<void> {
  const positions = getAllOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const currentPrice = await getQuickPrice(pos.token_mint);
      if (currentPrice === null) continue;

      const shouldTakeProfit = currentPrice >= pos.take_profit_price;
      const shouldStopLoss = currentPrice <= pos.stop_loss_price;

      if (!shouldTakeProfit && !shouldStopLoss) continue;

      const reason = shouldTakeProfit ? 'TAKE PROFIT' : 'STOP LOSS';
      const keypair = getActiveKeypair(pos.telegram_id);

      // Sell
      const sellResult = await sellToken(keypair, pos.token_mint, pos.amount_tokens);
      const exitPrice = currentPrice;
      const pnlSol = (exitPrice - pos.entry_price_sol) * pos.amount_tokens;
      const pnlPct = ((exitPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;

      // Log sell trade
      logTrade({
        telegram_id: pos.telegram_id,
        token_mint: pos.token_mint,
        token_symbol: pos.token_symbol,
        strategy: pos.strategy,
        side: 'sell',
        amount_sol: pos.amount_sol,
        amount_tokens: pos.amount_tokens,
        price_sol: exitPrice,
        tx_signature: sellResult.signature,
        status: 'filled',
        pnl_sol: pnlSol,
        pnl_pct: pnlPct,
        entry_price: pos.entry_price_sol,
      });

      removeOpenPosition(pos.token_mint);

      const emoji = pnlPct >= 0 ? 'PROFIT' : 'LOSS';
      await notifyUser(
        pos.telegram_id,
        `${reason} triggered [${emoji}]\n` +
        `Token: ${pos.token_symbol || pos.token_mint.slice(0, 8)}\n` +
        `PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)\n` +
        `TX: <code>${sellResult.signature}</code>`
      );

    } catch (err: any) {
      console.error('[Monitor] Error processing position:', err.message);
    }
  }
}
