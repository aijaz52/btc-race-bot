# BTC Race Bot

![Competition](https://make.fun/badge/btc-race-24h-20261115-0828.svg) ![Rank](https://make.fun/badge/btc-race-24h-20261115-0828/aijaz52/btc-race-bot/rank.svg) ![Reward](https://make.fun/badge/btc-race-24h-20261115-0828/aijaz52/btc-race-bot/reward.svg)

[View the competition on make.fun](https://make.fun/bounty/btc-race-24h-20261115-0828).

A cbBTC/USDC trading bot for the make.fun competition `btc-race-24h-20261115-0828`. It trades the replay symbol `CBBTC` using the `agent-fun/bars-replay/v1` protocol.

## Strategy

The bot uses selective mean-reversion with a trend filter: it buys short pullbacks below a recent average only when the longer trend is stable or rising.

- **Trend filter:** compares 48-bar and 120-bar exponential averages, checks the slow average's slope, and requires the price to remain near or above the slow trend.
- **Low-volatility stand-aside:** skips entries when recent return volatility is below 2 basis points or the 60-bar price range is below 40 basis points.
- **Fee-aware thresholds:** requires the pullback to exceed the estimated round-trip fees, slippage, and market impact, plus a margin. The entry threshold also accounts for recent price dispersion.
- **Position sizing:** holds at most one position, uses up to 85% of available cash, and respects the replay's position-weight, minimum-notional, and liquidity constraints.
- **Exits and risk controls:** exits on profitable mean reversion, a profit target, a trailing pullback, a stop loss, a broken trend, or a 60-bar timeout. It waits 20 bars after closing a position and halts new entries after a 10% drawdown from peak equity.

Indicators use observed closes only. Cash, order quantities, and position values use integer arithmetic. The bot rebuilds its indicators after a data gap longer than five minutes and retries rejected exits using the actual remaining position.

## Run

Use a recent Node.js release with native TypeScript support (Node.js 22.18+ or 24+). The protocol helper is vendored in `vendor/makefun-bars.ts`; no package installation is required.

```sh
node main.ts
```

The process speaks **stdin/stdout NDJSON**: each line is a complete JSON message under `agent-fun/bars-replay/v1`.

1. The replay harness sends a `hello` message with symbols, capital, fees, and trading limits.
2. The harness sends bar batches and account updates. The bot updates its indicators and emits exactly one `reply` per batch, including an empty `orders` array when standing aside or warming up.
3. A `done` message ends the replay and the process exits.

For a saved protocol input stream:

```sh
node main.ts < replay.ndjson > replies.ndjson
```

Standard output is reserved for protocol replies; send any added diagnostics to standard error. The replay harness supplies market data and simulates execution.

## Development grading

The bot was graded on the kit's development window with these results:

| Metric | Result |
| --- | ---: |
| Net PnL | +2.60 USDC |
| Trades | 6 |
| Win rate | 100% |
| Maximum drawdown | 0.12% |

These figures describe the kit's development window; competition rank and reward are shown by the badges above.
