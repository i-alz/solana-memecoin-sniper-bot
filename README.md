# Solana Memecoin Sniper Bot

Solana memecoin sniping bot with Telegram interface, Phantom wallet support, and Photon trading integration.

## Overview

This bot monitors Solana for new meme/token launches and automatically sends snipe transactions as soon as liquidity is added or a target trigger is detected.
Control the bot via Telegram commands, while trades are executed using your Phantom wallet and Photon's high-speed trading infrastructure.

## Features

- Real-time monitoring of new Solana token launches and liquidity pool events (e.g. Raydium / Pump.fun)
- Telegram bot interface for starting/stopping snipes, setting snipe parameters, and viewing status
- Phantom wallet integration for secure, non-custodial transaction signing
- Photon trading integration for fast, low-latency execution on Solana
- Configurable slippage, tip amount, snipe size, and filters (e.g. minimum liquidity, blacklist/whitelist)

## Tech Stack

- **Language / runtime:** Node.js with TypeScript (recommended)
- **Solana libraries:** `@solana/web3.js` plus RPC/webhook provider
- **Wallet:** Phantom (via Phantom Connect SDK)
- **Messaging:** Telegram Bot API for chat-based control
- **Trading:** Photon / Solana DEX as routing/execution layer

## Requirements

- Node.js v18+
- A Solana RPC endpoint (public or dedicated provider)
- A Phantom wallet with SOL for gas and snipes
- Telegram bot token (via BotFather)
- Photon account / API access

## Installation

1. Clone this repository:

```bash
git clone https://github.com/i-alz/solana-memecoin-sniper-bot.git
cd solana-memecoin-sniper-bot
```

2. Install dependencies:

```bash
npm install
```

3. Create and configure your environment file:

```bash
cp .env.example .env
```

Fill in values:
- `TELEGRAM_BOT_TOKEN`
- `RPC_ENDPOINT`
- `PHANTOM_WALLET_ADDRESS`
- `PHOTON_API_KEY`
- `SLIPPAGE_BPS`, `TIP_SOL`, `SNIPE_AMOUNT_SOL`

4. Build (TypeScript):

```bash
npm run build
```

## Usage

1. Start the bot:

```bash
npm run start
```

2. Control via Telegram:

- `/start` - start the sniper service
- `/stop` - stop all active snipes
- `/status` - show current targets, balances, and recent trades
- `/snipe <token_address>` - create a new snipe order for the specified token

3. Strategy:

- Bot listens for new liquidity pool events or token launches
- When a target matches your rules (liquidity, filters), it sends a transaction via Phantom and routes through Photon for execution

## Configuration

Key parameters (via `.env` or config file):

| Parameter | Description |
|---|---|
| `SNIPE_AMOUNT_SOL` | Amount of SOL per snipe |
| `TIP_SOL` | Priority fee / tip for faster confirmation |
| `SLIPPAGE_BPS` | Slippage tolerance in basis points |
| `MIN_LIQUIDITY` | Minimum liquidity filter |
| `BLACKLIST` | Comma-separated token addresses to ignore |

## Security & Risks

- Never use your primary wallet or large balances with this bot
- Meme coin trading is highly volatile; losses can be total and instant
- Use small amounts and test thoroughly on devnet before mainnet
- Verify all dependencies and RPC/trading providers

## Roadmap

- [ ] Advanced filters (social data, holder distribution, anti-rug heuristics)
- [ ] Multiple wallet support and position management
- [ ] Web dashboard for monitoring
- [ ] Additional DEX integrations and improved routing

## License

MIT
