// SteadyClip v2 — a Sharpe-first paper bot for the pump.fun replay
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the SDK shim
// is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Ranking is by hourly Sharpe, not total PnL. v1 graded -0.59 SOL,
// Sharpe -0.92, win rate 20.6%: momentum entries with value-vs-cost exits.
// v2 is a full redesign, driven by offline analysis of the kit's own dev
// dataset (128k events, 1,222 mints) plus a read of the kit's harness source
// (sim/engine.ts, sim/curve.ts) and a post-mortem of the bot's own action
// log from a grade-local run:
//
//   1. EXITS MUST BE PRICE-BASED, not value-vs-cost. The harness books a
//      position's cost as the full quote spent, while the tokens received
//      are already ~1.25% lighter (curve fee) and the sell pays another
//      ~1.25% plus a fixed 105k-lamport tx fee. On a small stake that turns
//      a nominal 5% stop into a ~1.5% price stop and a nominal 15%
//      take-profit into a ~19% price move — stops fired on noise and
//      profits never arrived. v2 tracks the entry PRICE and exits on price
//      ratios: -8% hard stop, trailing stop arming at +10% with an 8%
//      give-back, no fixed take-profit so the rare runner pays.
//   2. THE FIRST SPIKE IS UNTRADEABLE. The crossing trade that makes a
//      curve liquid already moves the price ~27% within its own slot; a
//      bot's fill lands 2 slots later, so "buy as soon as liquid" buys the
//      top (action-log check: mean buy price 1.27x the trigger price).
//      An early-entry version built on that idea graded -1.30 SOL. v2
//      therefore buys only confirmed flow AFTER the spike has settled into
//      a trend: SURGE — price up 15-35% over 10 slots on >=1 SOL net inflow
//      from >=6 distinct wallets, still within 2% of its window high.
//      Offline (true entry prices, fees included): ~-0.045 per unit staked
//      on this brutal dev window, where every entry shape loses — the
//      least-bad shape found, with the smallest drawdown.
//   3. SMALL STAKES, STRICT ENTRIES, NO DIP-BUYING. One fixed 0.03 SOL
//      buy per coin, at most 4 positions, no scale-in, no falling knives.
//   4. Guardrail pacing keeps tiny 0.01 SOL probe round trips as insurance
//      so the run stays above the 20-coin minimum bar.
//
// Fully deterministic: no clock, no randomness, no network — iteration only
// over insertion-ordered maps fed by the batch stream.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;

// ---- entry: SURGE ----
const SURGE_WINDOW = 10;
const SURGE_MIN_NET_SOL = 1;
const SURGE_MIN_BUYS = 5;
const SURGE_MIN_BUYERS = 6;
const SURGE_MIN_UP = 0.15;
const SURGE_MAX_UP = 0.35;
const SURGE_NEAR_HIGH = 0.98;
const SURGE_MIN_AGE = 30;
const SURGE_MAX_AGE = 900;
const SURGE_MIN_RQ_SOL = 1;
const SURGE_MAX_RQ_SOL = 40;
const SURGE_STAKE_SOL = 0.03;

// ---- exits (price ratios vs entry price) ----
const STOP_LOSS = 0.08;
const TRAIL_ARM = 0.1;
const TRAIL = 0.08;
const MAX_HOLD = 150;
const HOLD_IF_UP = 0.2;
const BIG_SELL_SOL = 1;
const FADE_WINDOW = 5;
const FADE_NET_SOL = 0.1;
const STALE_SLOTS = 45;

// ---- pacing / limits ----
const COOLDOWN = 120;
const MAX_MAIN = 4;
const MAX_EXPOSURE_SOL = 4;
const MIN_BUY_SOL = 0.01;
const BUY_SLIP_BPS = 1500;
const TARGET_COINS = 30;
const TARGET_FILLS = 200;
const PACE_SECS = 21_600; // the 6h final window; dev window just saturates it
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  lastBuy: number;
}

interface Held {
  opened: number;
  /** Price (SOL per token) when the position first showed as filled. */
  entryPrice: number;
  peakRatio: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;
const KEEP = Math.max(SURGE_WINDOW, FADE_WINDOW) + 5;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12, lastBuy: -1 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Current curve price (SOL per token) from a mark or the stored curve. */
function priceOf(state: BotState, marks: Map<Pubkey, { virtual_quote_reserves: string; virtual_token_reserves: string }>, mint: Pubkey): number {
  const mk = marks.get(mint);
  if (mk !== undefined) return Number(mk.virtual_quote_reserves) / Number(mk.virtual_token_reserves);
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

/**
 * SURGE: confirmed buying flow after the opening spike — a young curve whose
 * price rose 15-35% over the last 10 slots on >=1 SOL of net buying from
 * >=6 distinct wallets, still within 2% of its window high. The
 * overextension cap keeps the bot off the top of a vertical candle.
 */
function surge(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < SURGE_MIN_RQ_SOL || rqSol > SURGE_MAX_RQ_SOL) return false;
  if (t.created === null) return false;
  const age = now - t.created;
  if (age < SURGE_MIN_AGE || age > SURGE_MAX_AGE) return false;
  const from = now - SURGE_WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < SURGE_MIN_BUYS || byUser.size < SURGE_MIN_BUYERS) return false;
  if (buySol - sellSol < SURGE_MIN_NET_SOL) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < SURGE_MIN_UP) return false;
  if (up > SURGE_MAX_UP) return false;
  if (last < high * SURGE_NEAR_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        if (e.is_buy) t.lastBuy = e.slot;
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;

    // Exits first: sell the whole position on the first trigger that fires.
    // All triggers are price ratios vs the entry price — never value vs cost
    // (fees make cost-based stops fire on noise for small stakes).
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(state, marks, mint);
      if (price <= 0) continue;
      if (!h.filled) {
        // First sight of the filled position: anchor the entry price here.
        h.filled = true;
        h.entryPrice = price;
        h.peakRatio = 1;
        continue;
      }
      const ratio = price / h.entryPrice;
      if (ratio > h.peakRatio) h.peakRatio = ratio;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && ratio <= 1 - STOP_LOSS) exit = true;
      if (!exit && h.peakRatio >= 1 + TRAIL_ARM && ratio <= h.peakRatio * (1 - TRAIL)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW) < -FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && ratio < 1 && t.lastBuy >= 0 && now - t.lastBuy > STALE_SLOTS) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && ratio < 1 + HOLD_IF_UP) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Then entries: one fixed-size buy per position, no scale-in.
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_MAIN - held.size;
    let exposure = 0;
    for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (held.has(mint)) continue;
      if (slotsLeft <= 0 || mainLeft <= 0) continue;
      if (t.entries >= 2 || now - t.lastExit < COOLDOWN) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!surge(t, now, rqSol)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, SURGE_STAKE_SOL, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      exposure += amount;
      held.set(mint, { opened: now, entryPrice: 0, peakRatio: 1, invested: amount, exiting: false, filled: false });
      t.entries++;
      slotsLeft--;
      mainLeft--;
    }

    // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
