// Pump.fun Sharpe Sprint — "Steady Surge" paper bot (v2).
//
// v2 revision (after the v1 smoke test): three real changes.
//   1. Tiered sizing — the stake scales with signal strength instead of a
//      flat 0.15 SOL: a merely-OK surge gets 0.10 SOL, a strong one (buy
//      share >= 75% and momentum >= 20%) gets 0.20 SOL. Stronger signals
//      deserve more capital; weak ones less.
//   2. Spike guard + volume floor — skip the entry when the single most
//      recent trade spiked the price more than 12% (a parabolic jump that
//      usually reverts before our fill lands), and require at least 0.05 SOL
//      of recent traded volume so thin, noisy coins never qualify.
//   3. Partial take-profit — at +25% sell half the position and let the rest
//      ride under the trailing stop, instead of exiting everything at the
//      first target. That banks a win early (good for Sharpe) while keeping
//      upside on the runners.
//
// Idea (unchanged): ride only the earliest, healthiest leg of a fresh
// pump.fun coin and get out fast. A coin earns a buy when, over its most
// recent trades, it is (a) rising quickly, (b) bought far more than sold,
// and (c) has not already run away from its starting price. Every position
// is small, exits are mechanical (take-profit, stop-loss, trailing stop, max
// hold), and a mint is traded at most once, so the book turns over across
// many distinct coins instead of doubling down on one lucky runner.
//
// Wire protocol: agent-fun/replay/v2, spoken through the kit's SDK shim
// (vendor/makefun-bot.ts). No clock, no environment, no randomness — every
// decision comes from the batch stream, so two runs agree byte for byte.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Base SOL staked on every entry (0.10 SOL of the 10 SOL paper bankroll). */
const BASE_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n;
/** Strong-signal stake (0.20 SOL): buy share >= 75% and momentum >= 20%. */
const STRONG_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 5n;
/** Smallest buy worth sending: the guardrail needs round trips of >= 0.01 SOL. */
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 12n) / 1000n;
/** Slippage tolerance on fills (10%). */
const MAX_SLIPPAGE_BPS = 1000;

/** Entry needs at least this many trades of history on the coin. */
const MIN_TRADES_TO_ENTER = 6;
/** Entry needs this much rise over the last LOOKBACK_TRADES trades. */
const MIN_MOMENTUM = 0.1; // +10%
/** Strong-signal momentum for the bigger stake. */
const STRONG_MOMENTUM = 0.2; // +20%
/** Trades used for the momentum and buy-pressure windows. */
const LOOKBACK_TRADES = 6;
const PRESSURE_TRADES = 16;
/** Entry needs buys to be at least this share of recent traded SOL. */
const MIN_BUY_SHARE = 0.55;
/** Strong-signal buy share for the bigger stake. */
const STRONG_BUY_SHARE = 0.75;
/** Entry needs at least this much SOL traded over the pressure window. */
const MIN_PRESSURE_SOL = 0.05;
/** Skip the entry when the last single trade spiked the price this much. */
const MAX_LAST_JUMP = 0.12; // +12% in one trade: a spike, not a trend
/** Never chase a coin that already ran this far from its first seen price. */
const MAX_RUN_UP = 2.5;
/** Stop considering a coin once it has this many trades (its early leg is over). */
const MAX_TRADES_TO_ENTER = 150;

/** Take profit at +25% from the entry price. */
const TAKE_PROFIT = 1.25;
/** Stop loss at -15% from the entry price. */
const STOP_LOSS = 0.85;
/** Trailing stop: sell once the price falls 12% below its peak since entry. */
const TRAILING_DROP = 0.88;
/** Max hold, in slots (~0.4 s per slot, so ~16 minutes). */
const MAX_HOLD_SLOTS = 2400;

// ------------------------------------------------------------------ per-coin tape

interface Tape {
  /** Price (SOL per token) at the first trade we saw. */
  firstPrice: number;
  /** Last LOOKBACK_TRADES prices, oldest first. */
  recentPrices: number[];
  /** SOL bought / sold over the last PRESSURE_TRADES trades. */
  buySol: number;
  sellSol: number;
  /** Ring of the last PRESSURE_TRADES trade sizes, to age volume out. */
  recentTrades: { buy: boolean; sol: number }[];
  /** Total trades seen. */
  trades: number;
}

interface Held {
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
  /** True once the first half was sold at the take-profit level. */
  tookPartial: boolean;
}

const tapes = new Map<string, Tape>();
/** Mints we hold (or have a buy in flight for), with entry facts. */
const held = new Map<string, Held>();
/** Mints already bought once — one round trip per mint, no re-entry. */
const tradedOnce = new Set<string>();
/** Mints with a buy order still in flight. */
const buyPending = new Set<string>();
/** Mints with a sell order still in flight. */
const sellPending = new Set<string>();

/** Price of one token in SOL from a curve's virtual reserves. */
function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (!curve) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

/** Fold this batch's trades into the per-coin tapes. */
function observe(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
    if (!Number.isFinite(price) || price <= 0) continue;
    const sol = Number(e.sol_amount) / 1e9;
    let tape = tapes.get(e.mint);
    if (tape === undefined) {
      tape = { firstPrice: price, recentPrices: [], buySol: 0, sellSol: 0, recentTrades: [], trades: 0 };
      tapes.set(e.mint, tape);
    }
    tape.trades += 1;
    tape.recentPrices.push(price);
    if (tape.recentPrices.length > LOOKBACK_TRADES) tape.recentPrices.shift();
    tape.recentTrades.push({ buy: e.is_buy, sol });
    if (e.is_buy) tape.buySol += sol;
    else tape.sellSol += sol;
    if (tape.recentTrades.length > PRESSURE_TRADES) {
      const old = tape.recentTrades.shift()!;
      if (old.buy) tape.buySol -= old.sol;
      else tape.sellSol -= old.sol;
    }
  }
}

/** Drop bookkeeping for mints that are gone (completed, sold, flattened). */
function prune(state: BotState): void {
  for (const mint of [...tapes.keys()]) {
    const curve = state.curves.get(mint);
    if (curve?.complete && !state.positions.has(mint)) tapes.delete(mint);
  }
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint) && !buyPending.has(mint)) held.delete(mint);
  }
}

/**
 * Signal strength for the tape: 0 = no entry, 1 = base stake, 2 = strong stake.
 * A coin qualifies when it is rising quickly on mostly-buy volume, has not
 * already run away, traded enough SOL to be real, and did not just spike in
 * a single trade.
 */
function entrySignal(tape: Tape): 0 | 1 | 2 {
  if (tape.trades < MIN_TRADES_TO_ENTER || tape.trades > MAX_TRADES_TO_ENTER) return 0;
  if (tape.recentPrices.length < LOOKBACK_TRADES) return 0;
  const now = tape.recentPrices[tape.recentPrices.length - 1];
  const then = tape.recentPrices[0];
  if (then <= 0) return 0;
  const momentum = now / then - 1;
  if (momentum < MIN_MOMENTUM) return 0; // not rising fast enough
  if (now / tape.firstPrice > MAX_RUN_UP) return 0; // already ran away
  const prev = tape.recentPrices[tape.recentPrices.length - 2];
  if (prev > 0 && now / prev - 1 > MAX_LAST_JUMP) return 0; // one-trade spike: likely to revert
  const volume = tape.buySol + tape.sellSol;
  if (volume < MIN_PRESSURE_SOL) return 0; // too thin to trust
  const buyShare = tape.buySol / volume;
  if (buyShare < MIN_BUY_SHARE) return 0; // sellers in control
  if (buyShare >= STRONG_BUY_SHARE && momentum >= STRONG_MOMENTUM) return 2;
  return 1;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state, batch) {
    observe(batch);
    prune(state);

    // Reconcile pending flags with the fills that just landed.
    for (const f of batch.fills) {
      if (f.side === 'buy') buyPending.delete(f.mint);
      if (f.side === 'sell') sellPending.delete(f.mint);
      if (f.side === 'buy' && f.status === 'filled') {
        tradedOnce.add(f.mint);
        const entry = priceOf(state, f.mint);
        if (entry > 0 && !held.has(f.mint)) {
          held.set(f.mint, { entryPrice: entry, entrySlot: batch.slot, peakPrice: entry, tookPartial: false });
        }
      }
    }

    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: (BuyInput | SellInput)[] = [];

    // ---- exits first: free slots before opening new ones.
    for (const [mint, pos] of state.positions) {
      if (sellPending.has(mint)) continue;
      const info = held.get(mint);
      const price = priceOf(state, mint);
      if (price <= 0) continue;
      if (info !== undefined) {
        if (price > info.peakPrice) info.peakPrice = price;
      }
      const entry = info?.entryPrice ?? price;
      const age = batch.slot - (info?.entrySlot ?? batch.slot);
      const stopLoss = price <= entry * STOP_LOSS;
      const trailing = info !== undefined && price <= info.peakPrice * TRAILING_DROP;
      const stale = info !== undefined && age >= MAX_HOLD_SLOTS;
      // Take profit: sell half the first time the target is hit, so the win
      // is banked early while the rest rides the trailing stop.
      const takeProfit = price >= entry * TAKE_PROFIT;
      if (takeProfit && info !== undefined && !info.tookPartial && !stopLoss) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const half = pos.token_amount / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: MAX_SLIPPAGE_BPS });
          info.tookPartial = true;
          sellPending.add(mint);
        }
        continue;
      }
      // After the partial, the remainder rides: only a stop-loss, the
      // trailing stop, or the max hold may close it — not the take-profit
      // level again, or it would dump the runner the very next batch.
      const fullExit =
        stopLoss || trailing || stale || (takeProfit && info === undefined);
      if (!fullExit) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      sellPending.add(mint);
    }

    // ---- entries: fresh surges only, in batch event order.
    for (const e of batch.events) {
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (tradedOnce.has(mint) || buyPending.has(mint) || held.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      const strength = entrySignal(tape);
      if (strength === 0) continue;
      const stake = strength === 2 ? STRONG_STAKE_LAMPORTS : BASE_STAKE_LAMPORTS;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < stake ? cap : stake;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      buyPending.add(mint);
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
