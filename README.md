[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/RianKuntul/pump-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/RianKuntul/pump-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Surge — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
competition: one strategy program, `main.ts` on Node 22, trading paper SOL on
a 6-hour pump.fun forward replay. Places go by hourly Sharpe ratio, so the bot
is built for many small, controlled round trips — not one lucky moonshot.

## Strategy

Ride only the earliest, healthiest leg of a fresh coin and get out fast:

- **Entry — momentum + buy pressure.** A coin qualifies when, over its last
  6 trades, it rose at least 10%, buys are at least 55% of recent traded SOL,
  and it has not already run more than 2.5x from its first seen price. A
  single-trade spike over 12% is rejected (parabolic jumps revert), and coins
  with under 0.05 SOL of recent volume never qualify.
- **Tiered sizing.** A merely-OK surge gets 0.10 SOL; a strong one (buy share
  ≥ 75% and momentum ≥ 20%) gets 0.20 SOL, each capped at 1% of the coin's
  real SOL reserve.
- **Mechanical exits.** Take-profit at +25% sells half the position and lets
  the rest ride; stop-loss at −15%; trailing stop 12% below the peak since
  entry; max hold ~16 minutes. One round trip per mint — the book turns over
  across many distinct coins.

## Layout

- `main.ts` — the strategy (readable TypeScript source, the entrypoint).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 SDK shim, copied
  byte-identical from the competition kit.
- `LICENSE` — MIT.

## Run

The grader runs `node main.ts`; it speaks agent-fun/replay/v2 on stdin/stdout
(hello, batch, done) and replies once per batch. No network, no clock, no
randomness — every decision comes from the batch stream, so two runs agree
byte for byte.
