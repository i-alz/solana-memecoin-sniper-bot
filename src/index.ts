/**
 * index.ts
 *
 * Main entry point for the Solana Memecoin Sniper Bot.
 * Initializes the database, starts the Telegram bot, and optionally
 * starts the auto-sniper if enabled via environment variable.
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from './logger';
import { db } from './db';
import { startBot } from './bot';
import { startAutoSniper, stopAutoSniper } from './sniper';

const AUTO_SNIPE = process.env.AUTO_SNIPE === 'true';

async function main(): Promise<void> {
  logger.info('=== Solana Memecoin Sniper Bot starting ===');

  // Verify DB is accessible
  try {
    db.prepare('SELECT 1').get();
    logger.info('[DB] Database connection OK');
  } catch (err) {
    logger.error('[DB] Database init failed:', err);
    process.exit(1);
  }

  // Start Telegram bot
  try {
    await startBot();
    logger.info('[Bot] Telegram bot started');
  } catch (err) {
    logger.error('[Bot] Failed to start Telegram bot:', err);
    process.exit(1);
  }

  // Optionally start auto-sniper
  if (AUTO_SNIPE) {
    logger.info('[Sniper] AUTO_SNIPE=true — starting auto-sniper');
    startAutoSniper();
  } else {
    logger.info('[Sniper] AUTO_SNIPE not set — use /autosnipe on in Telegram to enable');
  }

  logger.info('=== Bot is running. Press Ctrl+C to stop. ===');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT — shutting down gracefully...');
  stopAutoSniper();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM — shutting down gracefully...');
  stopAutoSniper();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

main().catch((err) => {
  logger.error('Fatal error in main():', err);
  process.exit(1);
});
