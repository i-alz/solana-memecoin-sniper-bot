/**
 * bot.ts
 *
 * Telegram bot using Grammy.
 * Commands:
 *  /start - welcome + basic info
 *  /help - command list
 *  /wallet - manage wallets (add, list, set active)
 *  /balance - show SOL + token balances
 *  /risk - configure risk parameters (position size, TP, SL, daily loss cap, max positions)
 *  /autosnipe - start/stop auto-sniper
 *  /positions - show open positions
 *  /history - show recent trades
 *  /snipe <mint> - manually snipe a specific token
 *  /sell <mint> - manually sell a specific token
 */
import dotenv from 'dotenv';
dotenv.config();

import { Bot, Context } from 'grammy';
import { logger } from './logger';
import {
  addWallet,
  listWallets,
  getActivePublicKey,
  setActiveWallet,
} from './walletManager';
import { getSolBalance, getTokenBalance } from './solanaClient';
import {
  getRiskConfig,
  setRiskConfig,
  getOpenPositions,
  getTrades,
} from './db';
import { startAutoSniper, stopAutoSniper, isSniperActive } from './sniper';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');

const bot = new Bot(BOT_TOKEN);

// Helper to get Telegram ID string
function getTelegramId(ctx: Context): string {
  return String(ctx.from?.id ?? 0);
}

// ----- /start -----
bot.command('start', (ctx) => {
  ctx.reply(
    `Welcome to the Solana Memecoin Sniper Bot!\n\n` +
      `I can help you auto-snipe new Raydium/Pump.fun launches with configurable risk parameters.\n\n` +
      `Type /help to see available commands.`
  );
});

// ----- /help -----
bot.command('help', (ctx) => {
  ctx.reply(
    `*Commands:*\n` +
      `/start - Welcome message\n` +
      `/help - Show this help\n` +
      `/wallet - Manage Phantom wallets (add, list, set active)\n` +
      `/balance - Show SOL + token balances\n` +
      `/risk - Configure risk parameters\n` +
      `/autosnipe - Start/stop auto-sniper\n` +
      `/positions - Show open positions\n` +
      `/history - Show recent trades\n` +
      `/snipe <mint> - Manually snipe a token\n` +
      `/sell <mint> - Manually sell a token`,
    { parse_mode: 'Markdown' }
  );
});

// ----- /wallet -----
bot.command('wallet', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  const args = ctx.message?.text?.split(' ').slice(1) || [];

  if (args.length === 0) {
    const wallets = listWallets(telegramId);
    if (wallets.length === 0) {
      return ctx.reply(
        `You have no wallets yet.\n\nUsage:\n` +
          `/wallet add <base58_private_key> [label]\n` +
          `/wallet list\n` +
          `/wallet set <label>`
      );
    }
    const lines = wallets.map((w) => {
      const active = w.isActive ? '✅' : '';
      return `${active} ${w.label}: ${w.publicKey}`;
    });
    return ctx.reply(`Your wallets:\n${lines.join('\n')}`);
  }

  const subcommand = args[0];

  if (subcommand === 'add') {
    const privateKeyBase58 = args[1];
    const label = args[2] || 'default';
    if (!privateKeyBase58) {
      return ctx.reply('Usage: /wallet add <base58_private_key> [label]');
    }
    try {
      const wallet = addWallet(telegramId, privateKeyBase58, label);
      ctx.reply(
        `Wallet added!\nLabel: ${wallet.label}\nPublic key: ${wallet.publicKey}`
      );
    } catch (err: any) {
      ctx.reply(`Error: ${err.message}`);
    }
  } else if (subcommand === 'list') {
    const wallets = listWallets(telegramId);
    if (wallets.length === 0) {
      return ctx.reply('No wallets found.');
    }
    const lines = wallets.map((w) => {
      const active = w.isActive ? '✅' : '';
      return `${active} ${w.label}: ${w.publicKey}`;
    });
    return ctx.reply(`Your wallets:\n${lines.join('\n')}`);
  } else if (subcommand === 'set') {
    const label = args[1];
    if (!label) {
      return ctx.reply('Usage: /wallet set <label>');
    }
    try {
      setActiveWallet(telegramId, label);
      ctx.reply(`Active wallet set to: ${label}`);
    } catch (err: any) {
      ctx.reply(`Error: ${err.message}`);
    }
  } else {
    ctx.reply(
      'Usage:\n' +
        '/wallet add <base58_private_key> [label]\n' +
        '/wallet list\n' +
        '/wallet set <label>'
    );
  }
});

// ----- /balance -----
bot.command('balance', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  try {
    const publicKey = getActivePublicKey(telegramId);
    const solBalance = await getSolBalance(publicKey);
    ctx.reply(
      `Wallet: ${publicKey}\nSOL Balance: ${solBalance.toFixed(4)} SOL\n\n` +
        `(Token balances not yet implemented)`
    );
  } catch (err: any) {
    ctx.reply(`Error: ${err.message}`);
  }
});

// ----- /risk -----
bot.command('risk', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  const args = ctx.message?.text?.split(' ').slice(1) || [];

  if (args.length === 0) {
    try {
      const risk = getRiskConfig(telegramId);
      return ctx.reply(
        `Risk Config:\n` +
          `Position Size: ${risk.positionSizeSol} SOL\n` +
          `Stop Loss: ${risk.stopLossPct}%\n` +
          `Take Profit: ${risk.takeProfitPct}%\n` +
          `Max Daily Loss: ${risk.maxDailyLossSol} SOL\n` +
          `Max Open Positions: ${risk.maxOpenPositions}\n\n` +
          `Usage:\n` +
          `/risk set position 0.1\n` +
          `/risk set stoploss 50\n` +
          `/risk set takeprofit 300\n` +
          `/risk set maxdailyloss 1.0\n` +
          `/risk set maxpositions 3`
      );
    } catch {
      return ctx.reply(
        `No risk config found. Use /risk set <param> <value> to configure.`
      );
    }
  }

  const [action, param, value] = args;
  if (action !== 'set' || !param || !value) {
    return ctx.reply('Usage: /risk set <param> <value>');
  }

  try {
    let risk = getRiskConfig(telegramId);

    switch (param) {
      case 'position':
        risk.positionSizeSol = parseFloat(value);
        break;
      case 'stoploss':
        risk.stopLossPct = parseFloat(value);
        break;
      case 'takeprofit':
        risk.takeProfitPct = parseFloat(value);
        break;
      case 'maxdailyloss':
        risk.maxDailyLossSol = parseFloat(value);
        break;
      case 'maxpositions':
        risk.maxOpenPositions = parseInt(value);
        break;
      default:
        return ctx.reply(`Unknown parameter: ${param}`);
    }

    setRiskConfig(telegramId, risk);
    ctx.reply(`Risk parameter updated: ${param} = ${value}`);
  } catch (err: any) {
    ctx.reply(`Error: ${err.message}`);
  }
});

// ----- /autosnipe -----
bot.command('autosnipe', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  const args = ctx.message?.text?.split(' ').slice(1) || [];
  const action = args[0];

  if (action === 'on') {
    if (isSniperActive()) {
      return ctx.reply('Auto-sniper is already running.');
    }
    try {
      startAutoSniper(telegramId);
      ctx.reply('Auto-sniper started! Listening for new pools...');
    } catch (err: any) {
      ctx.reply(`Error: ${err.message}`);
    }
  } else if (action === 'off') {
    stopAutoSniper();
    ctx.reply('Auto-sniper stopped.');
  } else {
    ctx.reply(
      `Auto-sniper is ${isSniperActive() ? 'ON' : 'OFF'}.\n\n` +
        `Usage:\n/autosnipe on\n/autosnipe off`
    );
  }
});

// ----- /positions -----
bot.command('positions', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  try {
    const positions = getOpenPositions(telegramId);
    if (positions.length === 0) {
      return ctx.reply('No open positions.');
    }
    const lines = positions.map((p) => {
      return (
        `Token: ${p.tokenMint.substring(0, 8)}...\n` +
        `  Entry: ${p.entryPriceSol.toFixed(8)} SOL\n` +
        `  Amount: ${p.tokenAmount.toFixed(2)}`
      );
    });
    ctx.reply(`Open positions:\n${lines.join('\n\n')}`);
  } catch (err: any) {
    ctx.reply(`Error: ${err.message}`);
  }
});

// ----- /history -----
bot.command('history', async (ctx) => {
  const telegramId = getTelegramId(ctx);
  try {
    const trades = getTrades(telegramId, 10);
    if (trades.length === 0) {
      return ctx.reply('No trade history.');
    }
    const lines = trades.map((t) => {
      const pnl = t.pnlSol ?? 0;
      const emoji = pnl > 0 ? '🟢' : '🔴';
      return (
        `${emoji} ${t.action.toUpperCase()} ${t.tokenMint.substring(0, 8)}...\n` +
        `  PnL: ${pnl.toFixed(4)} SOL | Reason: ${t.reason || 'N/A'}`
      );
    });
    ctx.reply(`Recent trades:\n${lines.join('\n\n')}`);
  } catch (err: any) {
    ctx.reply(`Error: ${err.message}`);
  }
});

// ----- /snipe <mint> -----
bot.command('snipe', async (ctx) => {
  ctx.reply('Manual snipe not yet implemented. Use /autosnipe on to enable auto-sniping.');
});

// ----- /sell <mint> -----
bot.command('sell', async (ctx) => {
  ctx.reply('Manual sell not yet implemented. Positions auto-close based on TP/SL settings.');
});

/**
 * Start the bot.
 */
export async function startBot(): Promise<void> {
  await bot.start({
    onStart: ({ username }) => logger.info(`[Bot] Connected as @${username}`),
  });
}

export default bot;
