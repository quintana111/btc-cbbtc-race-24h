import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';
const DEPTH_WINDOW = 90;
const ENTRY_LOOKBACK = 12;
const LOCAL_LOW_WINDOW = 8;
const ENTRY_DRAWDOWN = 0.003;
const ENTRY_REBOUND = 0.004;
const PROFIT_TARGET = 0.007;
const HARD_STOP = 0.006;
const TRAIL_ARM = 0.004;
const TRAIL_GIVEBACK = 0.0035;
const MAX_HOLD_BARS = 30;
const COOLDOWN_BARS = 12;
const POSITION_BPS = 7000n;
const BPS_DENOMINATOR = 10000n;
const QUOTE_SCALE = 1_000_000n;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BAR_MS = 60 * 1000;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const closes: number[] = [];
let hello: any = null;
let validWindow = false;
let entryPrice: number | null = null;
let highestSinceEntry: number | null = null;
let entrySeq = -1;
let lastExitSeq = -10000;

function decide(batch: any): any[] {
  if (!validWindow) return [];
  const bar = batch.bars.find((item: any) => item.symbol === SYMBOL);
  if (!bar) return [];
  const price = Number(bar.c);
  if (!Number.isFinite(price) || price <= 0) return [];
  closes.push(price);
  if (closes.length > DEPTH_WINDOW) closes.shift();

  for (const fill of batch.fills ?? []) {
    if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
    if (fill.side === 'buy') {
      entryPrice = Number(fill.price);
      highestSinceEntry = entryPrice;
      entrySeq = batch.seq;
    } else if (fill.side === 'sell') {
      entryPrice = null;
      highestSinceEntry = null;
      entrySeq = -1;
      lastExitSeq = batch.seq;
    }
  }

  const position = batch.account.positions.find((item: any) => item.symbol === SYMBOL);
  if (position) {
    if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      entryPrice = price;
      entrySeq = batch.seq;
      highestSinceEntry = price;
    }
    highestSinceEntry = Math.max(highestSinceEntry ?? price, price);
    const returnFromEntry = price / entryPrice - 1;
    const peakReturn = highestSinceEntry / entryPrice - 1;
    const trailingExit = peakReturn >= TRAIL_ARM && price <= highestSinceEntry * (1 - TRAIL_GIVEBACK);
    const timeExit = batch.seq - entrySeq >= MAX_HOLD_BARS;
    if (returnFromEntry >= PROFIT_TARGET || returnFromEntry <= -HARD_STOP || trailingExit || timeExit) {
      return [{ side: 'sell', client_id: `sell-${batch.seq}`, symbol: SYMBOL, qty: position.qty, max_slippage_bps: 10000 }];
    }
    return [];
  }

  entryPrice = null;
  highestSinceEntry = null;
  entrySeq = -1;
  const cash = BigInt(batch.account.cash_quote_units);
  if (closes.length < 30 || batch.seq - lastExitSeq < COOLDOWN_BARS || cash < 2n * QUOTE_SCALE) return [];
  const endMs = hello.first_close_ms + WINDOW_MS;
  if (batch.t >= endMs - BAR_MS) return [];
  const peak = Math.max(...closes.slice(-ENTRY_LOOKBACK));
  const recent = closes.slice(-LOCAL_LOW_WINDOW);
  if (recent.length < 3) return [];
  const localLow = Math.min(...recent);
  const drawdown = peak / price - 1;
  const rebound = price / localLow - 1;
  const twoRisingCloses = closes.at(-1)! > closes.at(-2)! && closes.at(-2)! > closes.at(-3)!;
  if (drawdown < ENTRY_DRAWDOWN || rebound < ENTRY_REBOUND || !twoRisingCloses) return [];
  const notional = cash * POSITION_BPS / BPS_DENOMINATOR;
  if (notional < QUOTE_SCALE) return [];
  return [{ side: 'buy', client_id: `buy-${batch.seq}`, symbol: SYMBOL, notional_quote_units: notional.toString(), max_slippage_bps: 10000 }];
}

for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.type === 'hello') {
    hello = message;
    validWindow = Number.isSafeInteger(message.first_close_ms) && message.first_close_ms >= 0 && Number.isSafeInteger(message.first_close_ms + WINDOW_MS);
    continue;
  }
  if (message.type === 'batch') {
    const validSeq = Number.isSafeInteger(message.seq) && message.seq >= 0;
    const validTime = Number.isSafeInteger(message.t) && message.t >= 0;
    const orders = validSeq && validTime && hello && Array.isArray(message.bars) && Array.isArray(message.account?.positions) ? decide(message) : [];
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: message.seq, orders })}\n`);
    continue;
  }
  if (message.type === 'done') break;
  throw new Error(`unknown harness message: ${message.type}`);
}
