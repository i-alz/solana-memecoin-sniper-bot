import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/sniper.db';

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   TEXT PRIMARY KEY,
    username      TEXT,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   TEXT NOT NULL,
    label         TEXT NOT NULL DEFAULT 'default',
    public_key    TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    is_active     INTEGER DEFAULT 0,
    created_at    INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(telegram_id, label)
  );

  CREATE TABLE IF NOT EXISTS risk_configs (
    telegram_id          TEXT PRIMARY KEY,
    position_size_sol    REAL DEFAULT 0.1,
    stop_loss_pct        REAL DEFAULT 50,
    take_profit_pct      REAL DEFAULT 300,
    max_daily_loss_sol   REAL DEFAULT 1.0,
    max_open_positions   INTEGER DEFAULT 3,
    strategy             TEXT DEFAULT 'off',
    updated_at           INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     TEXT NOT NULL,
    token_mint      TEXT NOT NULL,
    token_symbol    TEXT,
    strategy        TEXT,
    side            TEXT NOT NULL,
    amount_sol      REAL,
    amount_tokens   REAL,
    price_sol       REAL,
    tx_signature    TEXT,
    status          TEXT DEFAULT 'pending',
    pnl_sol         REAL,
    pnl_pct         REAL,
    entry_price     REAL,
    created_at      INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS open_positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     TEXT NOT NULL,
    token_mint      TEXT NOT NULL UNIQUE,
    token_symbol    TEXT,
    strategy        TEXT,
    entry_price_sol REAL NOT NULL,
    amount_sol      REAL NOT NULL,
    amount_tokens   REAL NOT NULL,
    stop_loss_price REAL NOT NULL,
    take_profit_price REAL NOT NULL,
    buy_tx          TEXT,
    opened_at       INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ---- User helpers ----
export function upsertUser(telegramId: string, username?: string): void {
  db.prepare(`
    INSERT INTO users (telegram_id, username) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username
  `).run(telegramId, username ?? null);
}

// ---- Risk config helpers ----
export interface RiskConfig {
  position_size_sol: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  max_daily_loss_sol: number;
  max_open_positions: number;
  strategy: string;
}

export function getRiskConfig(telegramId: string): RiskConfig {
  const row = db.prepare('SELECT * FROM risk_configs WHERE telegram_id = ?').get(telegramId) as RiskConfig | undefined;
  if (row) return row;
  // Return defaults
  return {
    position_size_sol: parseFloat(process.env.DEFAULT_POSITION_SIZE_SOL || '0.1'),
    stop_loss_pct: parseFloat(process.env.DEFAULT_STOP_LOSS_PERCENT || '50'),
    take_profit_pct: parseFloat(process.env.DEFAULT_TAKE_PROFIT_PERCENT || '300'),
    max_daily_loss_sol: parseFloat(process.env.DEFAULT_MAX_DAILY_LOSS_SOL || '1.0'),
    max_open_positions: parseInt(process.env.DEFAULT_MAX_OPEN_POSITIONS || '3'),
    strategy: 'off',
  };
}

export function setRiskConfig(telegramId: string, config: Partial<RiskConfig>): void {
  const current = getRiskConfig(telegramId);
  const merged = { ...current, ...config };
  db.prepare(`
    INSERT INTO risk_configs
      (telegram_id, position_size_sol, stop_loss_pct, take_profit_pct, max_daily_loss_sol, max_open_positions, strategy, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(telegram_id) DO UPDATE SET
      position_size_sol  = excluded.position_size_sol,
      stop_loss_pct      = excluded.stop_loss_pct,
      take_profit_pct    = excluded.take_profit_pct,
      max_daily_loss_sol = excluded.max_daily_loss_sol,
      max_open_positions = excluded.max_open_positions,
      strategy           = excluded.strategy,
      updated_at         = excluded.updated_at
  `).run(telegramId, merged.position_size_sol, merged.stop_loss_pct, merged.take_profit_pct,
         merged.max_daily_loss_sol, merged.max_open_positions, merged.strategy);
}

export function setUserStrategy(telegramId: string, strategy: string): void {
  setRiskConfig(telegramId, { strategy });
}

// ---- Trade helpers ----
export function logTrade(trade: {
  telegram_id: string;
  token_mint: string;
  token_symbol?: string;
  strategy?: string;
  side: 'buy' | 'sell';
  amount_sol?: number;
  amount_tokens?: number;
  price_sol?: number;
  tx_signature?: string;
  status?: string;
  pnl_sol?: number;
  pnl_pct?: number;
  entry_price?: number;
}): number {
  const result = db.prepare(`
    INSERT INTO trades
      (telegram_id, token_mint, token_symbol, strategy, side,
       amount_sol, amount_tokens, price_sol, tx_signature, status, pnl_sol, pnl_pct, entry_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.telegram_id, trade.token_mint, trade.token_symbol ?? null, trade.strategy ?? null,
    trade.side, trade.amount_sol ?? null, trade.amount_tokens ?? null, trade.price_sol ?? null,
    trade.tx_signature ?? null, trade.status ?? 'pending', trade.pnl_sol ?? null,
    trade.pnl_pct ?? null, trade.entry_price ?? null
  );
  return result.lastInsertRowid as number;
}

export function getTradeHistory(telegramId: string, limit = 10) {
  return db.prepare('SELECT * FROM trades WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(telegramId, limit);
}

// ---- Open position helpers ----
export function addOpenPosition(pos: {
  telegram_id: string;
  token_mint: string;
  token_symbol?: string;
  strategy?: string;
  entry_price_sol: number;
  amount_sol: number;
  amount_tokens: number;
  stop_loss_price: number;
  take_profit_price: number;
  buy_tx?: string;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO open_positions
      (telegram_id, token_mint, token_symbol, strategy, entry_price_sol,
       amount_sol, amount_tokens, stop_loss_price, take_profit_price, buy_tx)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pos.telegram_id, pos.token_mint, pos.token_symbol ?? null, pos.strategy ?? null,
         pos.entry_price_sol, pos.amount_sol, pos.amount_tokens,
         pos.stop_loss_price, pos.take_profit_price, pos.buy_tx ?? null);
}

export function getOpenPositions(telegramId: string) {
  return db.prepare('SELECT * FROM open_positions WHERE telegram_id = ?').all(telegramId) as any[];
}

export function removeOpenPosition(tokenMint: string): void {
  db.prepare('DELETE FROM open_positions WHERE token_mint = ?').run(tokenMint);
}

export function getAllOpenPositions() {
  return db.prepare('SELECT * FROM open_positions').all() as any[];
}

// ---- Daily loss tracking ----
export function getTodayLossSol(telegramId: string): number {
  const today = Math.floor(Date.now() / 1000) - 86400;
  const row = db.prepare(`
    SELECT COALESCE(SUM(ABS(pnl_sol)), 0) as loss
    FROM trades
    WHERE telegram_id = ? AND side = 'sell' AND pnl_sol < 0 AND created_at > ?
  `).get(telegramId, today) as { loss: number };
  return row.loss;
}
