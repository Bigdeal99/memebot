# memebot: Solana memecoin bot (step 1: paper trading)

Scans trending Solana memecoins, rejects rugs with hard safety rules, asks **Grok (with live X search)**
whether the hype is real, and runs a **tournament of 4 strategies** with fake money on real market data.
After a week or two, the `report` command tells you which strategy actually makes money, and whether
the AI earns its cost. Only a winner goes live (step 2).

> This version never touches a wallet and cannot lose real money. Live trading is deliberately not built yet.

## How it works

```
DexScreener (new profiles & paid boosts)  ─┐
PumpPortal  (Pump.fun graduations, live)  ─┴─► watchlist ─► every 5 min, up to 12 checks per token:

 1. PREFILTER  liquidity ≥ $15k, mcap $30k–$30M, age < 48h, ≥150 txns/h, ≥$10k volume/h       (free)
 2. MOMENTUM   0–100 score: buy pressure, volume acceleration, turnover, trend.                  (free)
               Rewards deep pools and early moves; halved if dumping or vertical (+40%/5m or +150%/1h).
 3. SAFETY     RugCheck: mint/freeze authority revoked, LP ≥80% locked/burned, top-10 ≤30%,
               no wallet >10%, insiders ≤10%, no "danger" flags. ANY failure = never buy.       (free)
 4. AI         Grok + X search: hype 0–10, organic-vs-bots 0–10, red flags, buy/watch/avoid.   (paid, capped)
 5. ENTRY      each strategy decides on its own paper bankroll ($50, $5 per trade)
 6. EXITS      every 15s: stop loss, take-profit ladder, trailing stop, time stop, rug detection
 7. JOURNAL    data/trades.jsonl, data/decisions.jsonl, data/state.json + Telegram alerts
```

Paper fills are deliberately pessimistic: 1% friction per side **plus** AMM price impact
(size ÷ half the pool). Paper results that ignore slippage lie, and these would mislead you.

## The strategy tournament (6 strategies)

| Strategy | Entry | Exit |
|---|---|---|
| `hype_momentum` | momentum ≥60 + Grok "buy" or "watch", hype ≥4, organic ≥4 (no red flags) | −30% stop · half at 2x · 30% trailing stop · 6h time stop |
| `baseline` | **same rules, ignores the AI** (control group) | same as above |
| `quick_flip` | momentum ≥70, no AI | −20% stop · all out at +40% · 45 min |
| `moonshot` | momentum ≥65 + hype ≥7, organic ≥6 | −35% stop · ⅓ at 2x · ⅓ at 5x · 40% trail on the runner · 24h |
| `lottery` | momentum ≥50, no AI · tiny bets (40% of normal size), up to 10 at once | −50% stop · half at 2x (stake back) · rest rides with a 50% trail for up to 3 days |
| `basket` | momentum ≥50, no AI · up to 50 coins, each 1/50 of the round's money | no single-coin exits · sells **everything** when the basket hits 2x, drops to 0.5x or is 7 days old, then starts the next round with all of it |

All strategies share these guards: max 5 open positions, a daily loss limit (4 × position size),
and no re-buying the same token within 6h (no revenge trades).
`hype_momentum` vs `baseline` is an A/B test that shows whether Grok is worth paying for.
Strategies are plain data in `src/strategies.ts`, so adding your own takes a few lines.

## Setup (needs Node.js 22.4+)

```bash
npm install
cp .env.example .env      # add XAI_API_KEY and Telegram (both optional)
npm run doctor            # checks every API from your machine
npm start                 # runs until Ctrl+C; state survives restarts
npm run report            # scoreboard, AI A/B test, exit reasons, winners-vs-losers features
npm test                  # 35 offline tests incl. an end-to-end run with simulated market data
```

Without `XAI_API_KEY` the bot is 100% free: `baseline` and `quick_flip` still trade.
Run it for a day without the key first to see what flows through.

## Costs

| Item | Cost |
|---|---|
| DexScreener API, RugCheck API, PumpPortal migrations, Telegram | free |
| Grok (`grok-4-1-fast`: $0.20 in / $0.50 out per 1M tokens + X Search $5 per 1,000 posts read) | estimate ~$0.05–0.20 per call → ~$1–4/day at the default cap of 20 calls/day. Check real usage in the xAI console after day 1 |
| Where it runs | your own PC ($0), or a small VPS (~$5–10/month) to run 24/7 |

## Reading the report

- **per trade $** (expectancy) is the number that matters. Win rate alone means nothing:
  a 35% win rate with big winners beats a 70% win rate with small winners.
- Trust nothing below ~50 closed trades per strategy. Memecoin results are very noisy.
- **What winners had vs losers** shows which entry features really separate good trades from bad ones.
  Use it to tighten `.env` thresholds and the weights in `src/signals.ts`.

## Roadmap

- **Step 2: live trading** for the winning strategy only: Jupiter swap execution, a separate burner wallet
  holding only the trading money, simulate-before-send, a sell-quote check before every buy (honeypot test),
  max slippage, priority fees, a global kill switch, and $5–10 per trade at first.
- **Step 3: edge upgrades.** Dev-wallet history (serial ruggers), smart-money wallets learned from our
  own winning trades, faster data (Helius websockets), and auto-tuning thresholds from the journal.

## Safety rules for you

- Never put your main wallet's private key or seed phrase in any bot, this one included. Step 2 will
  use a dedicated wallet.
- Never run "trading bots" from random GitHub repos. Several fake Solana bots steal wallets.
- Memecoins can go to zero in minutes. Only trade money you can lose completely.
- Crypto gains are taxable in most countries. `data/trades.jsonl` is your record.
