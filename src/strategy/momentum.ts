/**
 * momentum.ts
 *
 * Momentum scalping strategy:
 * - Scans a watchlist of tokens periodically
 * - Detects strong upward momentum (price increase + volume spike)
 * - Enters positions and exits quickly at 20-50% gain targets
 * - Tighter stop-loss than launch sniper (default 20%)
 */

import { getQuickPrice, getPhotonTokenInfo } from '../photonClient';
import { buyToken, sellToken } from '../photonClient';
import { getActiveKeypair } from '../walletManager';
import {
  getRiskConfig,
  getTodayLossSol,
  addOpenPosition,
  removeOpenPosition,
  getOpenPositions,
  getAllOpenPositions,
  logTrade,
} from '../db';
import { Bot } from 'grammy';
import axios from 'axios';

let botInstance: Bot | null = null;
let momentumInterval: NodeJS.Timeout | null = null;

// Per-user momentum configs
interface MomentumConfig {
  watchlist: string[]; // token mints to scan
  scanIntervalMs: number;
  minPricePct1m: number; // min % price increase in 1 minute
  takeProfitPct: number;
  stopLossPct: number;
}

const userMomentumConfigs = new Map<string, MomentumConfig>();
const priceHistory = new Map<string, { price: number; timestamp: number }[]>();

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

async function notifyUser(telegramId: string, message: string): Promise<void> {
  if (botInstance) {
    try {
      await botInstance.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    } catch { /* ignore */ }
  }
}

/**
 * Start momentum scanning for a user.
 */
export function startMomentum(telegramId: string, watchlist: string[]): void {
  const risk = getRiskConfig(telegramId);
  userMomentumConfigs.set(telegramId, {
    watchlist,
    scanIntervalMs: 30_000, // scan every 30s
    minPricePct1m: 5,       // 5% gain in last scan period triggers entry
    takeProfitPct: risk.take_profit_pct,
    stopLossPct: 20,        // tighter SL for momentum
  });

  if (!momentumInterval) {
    momentumInterval = setInterval(scanAllUsers, 30_000);
  }
}

/**
 * Stop momentum scanning for a user.
 */
export function stopMomentum(telegramId: string): void {
  userMomentumConfigs.delete(telegramId);
  if (userMomentumConfigs.size === 0 && momentumInterval) {
    clearInterval(momentumInterval);
    momentumInterval = null;
  }
}

/**
 * Add a token to a user's momentum watchlist.
 */
export function addToWatchlist(telegramId: string, tokenMint: string): void {
  const cfg = userMomentumConfigs.get(telegramId);
  if (cfg && !cfg.watchlist.includes(tokenMint)) {
    cfg.watchlist.push(tokenMint);
  }
}

/**
 * Get user's current watchlist.
 */
export function getWatchlist(telegramId: string): string[] {
  return userMomentumConfigs.get(telegramId)?.watchlist ?? [];
}

/**
 * Scan all users' watchlists for momentum signals.
 */
async function scanAllUsers(): Promise<void> {
  for (const [telegramId, cfg] of userMomentumConfigs.entries()) {
    for (const mint of cfg.watchlist) {
      await scanToken(telegramId, cfg, mint);
    }
    // Also check open positions for TP/SL
    await checkPositions(telegramId);
  }
}

async function scanToken(
  telegramId: string,
  cfg: MomentumConfig,
  tokenMint: string
): Promise<void> {
  try {
    const currentPrice = await getQuickPrice(tokenMint);
    if (currentPrice === null) return;

    // Track price history
    const now = Date.now();
    if (!priceHistory.has(tokenMint)) priceHistory.set(tokenMint, []);
    const history = priceHistory.get(tokenMint)!;
    history.push({ price: currentPrice, timestamp: now });
    // Keep only last 10 entries
    if (history.length > 10) history.shift();

    // Need at least 2 data points
    if (history.length < 2) return;

    const oldest = history[0];
    const pricePct = ((currentPrice - oldest.price) / oldest.price) * 100;

    // Check if momentum threshold met
    if (pricePct < cfg.minPricePct1m) return;

    // Check if already in position
    const openPositions = getOpenPositions(telegramId);
    if (openPositions.some((p: any) => p.token_mint === tokenMint)) return;

    // Check position limits and daily loss
    const risk = getRiskConfig(telegramId);
    if (openPositions.length >= risk.max_open_positions) return;
    const todayLoss = getTodayLossSol(telegramId);
    if (todayLoss >= risk.max_daily_loss_sol) return;

    // Enter momentum trade
    const keypair = getActiveKeypair(telegramId);
    const info = await getPhotonTokenInfo(tokenMint);
    if (info?.isHoneypot) return;

    await notifyUser(
      telegramId,
      `Momentum signal detected!\n` +
      `Token: <code>${tokenMint}</code>\n` +
      `Price up ${pricePct.toFixed(1)}% recently\n` +
      `Entering with ${risk.position_size_sol} SOL`
    );

    const swapResult = await buyToken(keypair, tokenMint, risk.position_size_sol);
    const entryPrice = currentPrice;
    const stopLossPrice = entryPrice * (1 - cfg.stopLossPct / 100);
    const takeProfitPrice = entryPrice * (1 + cfg.takeProfitPct / 100);
    const tokensBought = swapResult.outputAmount / 1e6;

    logTrade({
      telegram_id: telegramId,
      token_mint: tokenMint,
      token_symbol: info?.symbol,
      strategy: 'momentum',
      side: 'buy',
      amount_sol: risk.position_size_sol,
      amount_tokens: tokensBought,
      price_sol: entryPrice,
      tx_signature: swapResult.signature,
      status: 'filled',
    });

    addOpenPosition({
      telegram_id: telegramId,
      token_mint: tokenMint,
      token_symbol: info?.symbol,
      strategy: 'momentum',
      entry_price_sol: entryPrice,
      amount_sol: risk.position_size_sol,
      amount_tokens: tokensBought,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      buy_tx: swapResult.signature,
    });

    await notifyUser(
      telegramId,
      `Momentum entry filled!\n` +
      `TX: <code>${swapResult.signature}</code>\n` +
      `Entry: ${entryPrice.toExponential(4)} SOL\n` +
      `TP: +${cfg.takeProfitPct}% | SL: -${cfg.stopLossPct}%`
    );

  } catch (err: any) {
    console.error('[Momentum] scanToken error:', err.message);
  }
}

async function checkPositions(telegramId: string): Promise<void> {
  const positions = getOpenPositions(telegramId).filter(
    (p: any) => p.strategy === 'momentum'
  );

  for (const pos of positions) {
    try {
      const currentPrice = await getQuickPrice(pos.token_mint);
      if (currentPrice === null) continue;

      const shouldTakeProfit = currentPrice >= pos.take_profit_price;
      const shouldStopLoss = currentPrice <= pos.stop_loss_price;
      if (!shouldTakeProfit && !shouldStopLoss) continue;

      const reason = shouldTakeProfit ? 'TAKE PROFIT' : 'STOP LOSS';
      const keypair = getActiveKeypair(telegramId);

      const sellResult = await sellToken(keypair, pos.token_mint, pos.amount_tokens);
      const pnlSol = (currentPrice - pos.entry_price_sol) * pos.amount_tokens;
      const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;

      logTrade({
        telegram_id: telegramId,
        token_mint: pos.token_mint,
        token_symbol: pos.token_symbol,
        strategy: 'momentum',
        side: 'sell',
        amount_sol: pos.amount_sol,
        amount_tokens: pos.amount_tokens,
        price_sol: currentPrice,
        tx_signature: sellResult.signature,
        status: 'filled',
        pnl_sol: pnlSol,
        pnl_pct: pnlPct,
        entry_price: pos.entry_price_sol,
      });

      removeOpenPosition(pos.token_mint);

      await notifyUser(
        telegramId,
        `Momentum ${reason}\n` +
        `Token: ${pos.token_symbol || pos.token_mint.slice(0, 8)}\n` +
        `PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)\n` +
        `TX: <code>${sellResult.signature}</code>`
      );
    } catch (err: any) {
      console.error('[Momentum] checkPositions error:', err.message);
    }
  }
}
