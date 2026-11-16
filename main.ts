import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

// Indicators use only observed closes. Money, sizing and order quantities stay integers.
const SYMBOL = 'CBBTC';
const BPS = 10_000;
const closes: number[] = [];
const slowHistory: number[] = [];
let trend = 0;
let slow = 0;
let previousTime: number | null = null;
let held = false;
let entrySeq = 0;
let peakValue = 0n;
let entryStopBps = 90;
let cooldownUntil = 0;
let exitPending = false;
let exitAttempts = 0;
let equityPeak = 0n;
let halted = false;

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

await runBars({
  onBatch(state, batch): OrderInput[] {
    // Accounts, rather than submitted orders, are the source of truth after a rejection.
    const position = state.positions.get(SYMBOL);
    const hasPosition = position !== undefined && position.qty > 0n;
    if (hasPosition && !held) {
      entrySeq = batch.seq;
      peakValue = state.value(SYMBOL, position.qty);
      exitPending = false;
      exitAttempts = 0;
    }
    if (!hasPosition && held) {
      cooldownUntil = batch.seq + 20;
      peakValue = 0n;
      exitPending = false;
      exitAttempts = 0;
    }
    held = hasPosition;

    if (!state.warmingUp) {
      if (state.equity > equityPeak) equityPeak = state.equity;
      if (equityPeak > 0n && state.equity * 100n <= equityPeak * 90n) halted = true;
    }

    // Never trade on a stale cached bar. After a long gap, rebuild the indicators.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];
    const price = Number(bar.c);
    if (!Number.isFinite(price) || price <= 0) return [];
    if (previousTime !== null && bar.t - previousTime > 5 * 60_000) {
      closes.length = 0;
      slowHistory.length = 0;
      trend = slow = 0;
    }
    previousTime = bar.t;
    trend = trend === 0 ? price : trend + (2 / 49) * (price - trend);
    slow = slow === 0 ? price : slow + (2 / 121) * (price - slow);
    slowHistory.push(slow);
    if (slowHistory.length > 16) slowHistory.shift();
    closes.push(price);
    if (closes.length > 120) closes.shift();

    const recent = closes.slice(-30);
    const returns = recent.slice(1).map((p, i) => (p / recent[i] - 1) * BPS);
    const volatility = returns.length === 0 ? 0 : Math.sqrt(mean(returns.map((r) => r * r)));
    const fair = mean(closes.slice(-10));
    const fees = state.hello.fees;
    const baseCost = 2 * (fees.fee_bps + fees.slippage_bps);
    const depth = state.depthAt(SYMBOL);
    const validDepth = depth !== null && depth.length > 0 && depth.every((d) => d > 0n);

    if (state.warmingUp || state.hello.caps.max_orders_per_bar < 1) return [];

    if (position && hasPosition) {
      const value = state.value(SYMBOL, position.qty);
      if (value > peakValue) peakValue = value;
      const cost = position.cost;
      const gainBps = cost > 0n ? Number((value - cost) * 10_000n / cost) : 0;
      const impact = validDepth ? Number(state.impactBps(SYMBOL, value) ?? 0n) + 1 : 20;
      const netGain = gainBps - fees.fee_bps - fees.slippage_bps - impact;
      const drawdownBps = peakValue > 0n ? Number((peakValue - value) * 10_000n / peakValue) : 0;
      const trendBroken = batch.seq - entrySeq >= 15 && price < slow * 0.985 && trend < slow;
      const reverted = price >= fair && netGain >= 8;
      const profitTarget = netGain >= Math.max(50, volatility * 4);
      const trailing = netGain > 12 && drawdownBps >= Math.max(20, volatility * 2);
      const stop = gainBps <= -entryStopBps;
      const timedOut = batch.seq - entrySeq >= 60;
      if (halted || reverted || profitTarget || trailing || stop || trendBroken || timedOut) exitPending = true;
      if (!exitPending) return [];
      // A rejected exit stays latched and retries against the actual remaining quantity.
      const slippage = Math.min(10_000, Math.max(stop || halted ? 300 : 100,
        Math.ceil(impact + fees.slippage_bps + volatility * 4)) + exitAttempts * 100);
      exitAttempts++;
      return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: slippage }];
    }

    if (halted || batch.seq < cooldownUntil || closes.length < 90 || !validDepth) return [];
    if (state.positions.size > 0 || state.hello.caps.max_open_positions < 1) return [];

    // Buy short pullbacks only while the longer trend is rising.
    const range = closes.slice(-60);
    const rangeBps = (Math.max(...range) / Math.min(...range) - 1) * BPS;
    const slowBefore = slowHistory[0];
    const slopeBps = (slow / slowBefore - 1) * BPS;
    const trendOkay = trend >= slow * 0.999 && slopeBps >= 0 && price >= slow * 0.998;
    if (!trendOkay || volatility < 2 || rangeBps < 40) return [];

    // Respect weight room and cap each hop's own impact at 6 bps.
    let spend = state.cash * 85n / 100n;
    const room = state.weightRoom(SYMBOL);
    if (spend > room) spend = room;
    const entryDepth = depth ?? [];
    for (const d of entryDepth) {
      const depthLimit = d * 6n / 10_000n / BigInt(entryDepth.length);
      if (spend > depthLimit) spend = depthLimit;
    }
    const minimum = BigInt(fees.min_notional_quote_units) > 1_000_000n
      ? BigInt(fees.min_notional_quote_units) : 1_000_000n;
    if (spend < minimum) return [];

    const impact = Number(state.impactBps(SYMBOL, spend) ?? 0n) + 1;
    const roundTrip = baseCost + 2 * impact;
    const dipBps = (fair / price - 1) * BPS;
    const deviation = Math.sqrt(mean(closes.slice(-20).map((p) => ((p / fair - 1) * BPS) ** 2)));
    const requiredDip = Math.max(20, roundTrip + 5, deviation * 0.4);
    // The short mean locates pullbacks; the slow trend keeps entries out of falling markets.
    if (dipBps < requiredDip) return [];

    entryStopBps = 30;
    cooldownUntil = batch.seq + 3; // also throttles rejected buys
    return [{
      side: 'buy', symbol: SYMBOL, notional_quote_units: spend,
      max_slippage_bps: Math.min(65, Math.max(20, Math.ceil(impact + fees.slippage_bps + volatility * 2))),
    }];
  },
});
