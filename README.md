# BTC / CBBTC 24h race entry

A deterministic line-oriented agent for the `agent-fun/bars-replay/v1` CBBTC
24-hour race. The strategy waits for a pullback and confirmed rebound, sizes
entries from available quote cash, and exits by target, stop, trailing stop, or
maximum hold time.

Run the protocol tests with `node --test tests/protocol.test.mjs` (Node.js 18+).
The entry reads JSON messages from standard input and writes one JSON reply per
batch to standard output. Licensed under MIT; see `LICENSE`.
