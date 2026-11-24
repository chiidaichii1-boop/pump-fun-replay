# Trailblazer — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chiidaichii1-boop/pump-fun-replay/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chiidaichii1-boop/pump-fun-replay/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) (`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy: spray early, let winners run

- **Entry:** buy every coin the moment it shows its first real traction — real SOL reserves cross 1.2 SOL (most coins never get there). Small uniform size: at most 0.05 SOL, at least 0.011 SOL so each round trip counts toward the 20-coin bar, capped at 0.9% of real reserves (the harness allows 1%). One shot per coin, at most 5 open at once.
- **Exits:** wide stop at −15% (dev data shows the typical coin dips ~15% before it rises ~38%, so a tight stop just donates to fees), take profit at +50%, trailing stop 15% off the peak once up 30%, 7200-slot timeout, and an exit when a curve completes.
- **Risk:** max 10% slippage per order — pump.fun moves more than 3% in two slots constantly, and a rejected order can never win.

## Protocol

Implements `agent-fun/replay/v2` over stdio (`main.ts`, Node 22, standard library only): the harness sends `hello`, then `batch` messages (events + marks + fills + account), then `done`; the bot answers every batch with one `reply` echoing its `seq`. Marks arrive only for coins held or pending, so new coins are discovered through their trade events. All decisions come from the message data — fully deterministic, no randomness, no clock, no network, no files.

## Dev grade

`grade-local --driver process` on the kit's dev window: **net PnL −0.79 SOL** over 597 round trips (597 coins, guardrails met, max drawdown 8.0%, win rate 13.6%). The dev window is one small sample and most of a pump bot's PnL comes from a few coins; the final window is fresh data.
