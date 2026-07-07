import crypto from 'crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { db } from './db';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const ENC_KEY_HEX = process.env.ENCRYPTION_KEY || '';

if (!ENC_KEY_HEX || ENC_KEY_HEX.length !== 64) {
  console.warn('[WalletManager] WARNING: ENCRYPTION_KEY not set or invalid. Wallet storage will be insecure.');
}

function getEncKey(): Buffer {
  return Buffer.from(ENC_KEY_HEX, 'hex');
}

// ---- Encryption helpers ----
function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as: iv:authTag:encrypted (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext: string): string {
  const [ivHex, authTagHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncKey(), iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

// ---- Public API ----

export interface WalletInfo {
  id: number;
  telegramId: string;
  label: string;
  publicKey: string;
  isActive: boolean;
}

/**
 * Add a wallet from a base58-encoded private key.
 * The private key is encrypted before storage.
 */
export function addWallet(
  telegramId: string,
  privateKeyBase58: string,
  label = 'default'
): WalletInfo {
  // Validate the key by creating a Keypair
  let keypair: Keypair;
  try {
    const decoded = bs58.decode(privateKeyBase58);
    keypair = Keypair.fromSecretKey(decoded);
  } catch {
    throw new Error('Invalid private key. Please provide a valid base58-encoded Solana private key.');
  }

  const publicKey = keypair.publicKey.toBase58();
  const encryptedKey = encrypt(privateKeyBase58);

  // Deactivate existing wallets for this label first
  db.prepare(
    'UPDATE wallets SET is_active = 0 WHERE telegram_id = ? AND label = ?'
  ).run(telegramId, label);

  const result = db.prepare(`
    INSERT INTO wallets (telegram_id, label, public_key, encrypted_key, is_active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(telegram_id, label) DO UPDATE SET
      public_key    = excluded.public_key,
      encrypted_key = excluded.encrypted_key,
      is_active     = 1
  `).run(telegramId, label, publicKey, encryptedKey);

  return {
    id: result.lastInsertRowid as number,
    telegramId,
    label,
    publicKey,
    isActive: true,
  };
}

/**
 * List all wallets for a user (without exposing private keys).
 */
export function listWallets(telegramId: string): WalletInfo[] {
  const rows = db.prepare(
    'SELECT * FROM wallets WHERE telegram_id = ? ORDER BY created_at ASC'
  ).all(telegramId) as any[];

  return rows.map(r => ({
    id: r.id,
    telegramId: r.telegram_id,
    label: r.label,
    publicKey: r.public_key,
    isActive: !!r.is_active,
  }));
}

/**
 * Get the active wallet keypair for a user.
 */
export function getActiveKeypair(telegramId: string): Keypair {
  const row = db.prepare(
    'SELECT * FROM wallets WHERE telegram_id = ? AND is_active = 1 LIMIT 1'
  ).get(telegramId) as any;

  if (!row) {
    throw new Error('No active wallet found. Use /add_wallet to import a wallet first.');
  }

  const privateKeyBase58 = decrypt(row.encrypted_key);
  const decoded = bs58.decode(privateKeyBase58);
  return Keypair.fromSecretKey(decoded);
}

/**
 * Get the active wallet public key for a user.
 */
export function getActivePublicKey(telegramId: string): string {
  const row = db.prepare(
    'SELECT public_key FROM wallets WHERE telegram_id = ? AND is_active = 1 LIMIT 1'
  ).get(telegramId) as any;

  if (!row) throw new Error('No active wallet found.');
  return row.public_key;
}

/**
 * Set a specific wallet (by label) as active.
 */
export function setActiveWallet(telegramId: string, label: string): void {
  const wallet = db.prepare(
    'SELECT id FROM wallets WHERE telegram_id = ? AND label = ?'
  ).get(telegramId, label) as any;

  if (!wallet) throw new Error(`Wallet labeled '${label}' not found.`);

  db.prepare('UPDATE wallets SET is_active = 0 WHERE telegram_id = ?').run(telegramId);
  db.prepare('UPDATE wallets SET is_active = 1 WHERE id = ?').run(wallet.id);
}

/**
 * Remove a wallet.
 */
export function removeWallet(telegramId: string, label: string): void {
  db.prepare('DELETE FROM wallets WHERE telegram_id = ? AND label = ?').run(telegramId, label);
}
