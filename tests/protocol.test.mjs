import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = resolve(root, 'main.ts');

const hello = {
  type: 'hello', protocol: 'agent-fun/bars-replay/v1', seed: '7',
  symbols: [{ symbol: 'CBBTC', mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', price_scale: 8, qty_scale: 8 }],
  capital: { quote: 'USDC', quote_scale: 6, quote_units: '1000000000' },
  bar_interval: '1m', first_close_ms: 1794525300000,
  caps: { max_open_positions: 1, max_orders_per_bar: 16, max_weight_bps: 10000, shorts: false, leverage: false },
  fees: { fee_bps: 4, slippage_bps: 2, min_notional_quote_units: '1000000' },
  latency_bars: 1,
};
const batch = {
  type: 'batch', seq: 0, t: 1794525300000,
  bars: [{ symbol: 'CBBTC', t: 1794525300000, o: '7140657549', h: '7140875950', l: '7140657549', c: '7140875950', v: null, o_depth: ['1012566251136'], c_depth: ['1013081782932'] }],
  fills: [], account: { cash_quote_units: '1000000000', positions: [], equity_quote_units: '1000000000' },
};
const done = { type: 'done', seq: 1, reason: 'end_of_data', account: batch.account };

test('answers each batch once and stays silent for hello and done', () => {
  const input = [hello, batch, done].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  assert.equal(run.stderr, '');
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'reply', seq: 0, orders: [] });
});

function makeBatch(seq, price, cash = '1000000000', positions = []) {
  const p = String(price);
  return {
    type: 'batch', seq, t: hello.first_close_ms + seq * 60000,
    bars: [{ symbol: 'CBBTC', t: hello.first_close_ms + seq * 60000, o: p, h: p, l: p, c: p, v: null, o_depth: ['1012566251136'], c_depth: ['1013081782932'] }],
    fills: [], account: { cash_quote_units: cash, positions, equity_quote_units: cash },
  };
}

test('buys after a deep pullback has a confirmed rebound', () => {
  const prices = [...Array(60).fill(10000000000), 9700000000, 9790000000, 9810000000];
  const messages = [hello, ...prices.map((p, seq) => makeBatch(seq, p)), done];
  const input = messages.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  const order = replies.at(-1).orders[0];
  assert.equal(order?.side, 'buy');
  assert.equal(order?.symbol, 'CBBTC');
  assert.equal(order?.notional_quote_units, '700000000');
});

test('buys after a short pullback turns into an 8-bar recovery', () => {
  const prices = [...Array(60).fill(10000000000), 9920000000, 9940000000, 9970000000];
  const messages = [hello, ...prices.map((p, seq) => makeBatch(seq, p)), done];
  const input = messages.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.at(-1).orders[0]?.side, 'buy');
});

test('stays out when price has already recovered near its recent high', () => {
  const prices = [...Array(60).fill(10000000000), 9920000000, 9960000000, 9990000000];
  const messages = [hello, ...prices.map((p, seq) => makeBatch(seq, p)), done];
  const input = messages.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.at(-1).orders, []);
});

test('fails closed when hello.first_close_ms is missing or malformed', () => {
  const prices = [...Array(60).fill(10000000000), 9700000000, 9790000000, 9810000000];
  for (const invalid of [undefined, 'not-a-time']) {
    const invalidHello = { ...hello };
    if (invalid === undefined) delete invalidHello.first_close_ms;
    else invalidHello.first_close_ms = invalid;
    const input = [invalidHello, ...prices.map((p, seq) => makeBatch(seq, p)), done].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
    const replies = run.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies.at(-1).orders, []);
  }
});

test('does not emit orders when a high-signal batch has missing or malformed time', () => {
  const prices = [...Array(60).fill(10000000000), 9700000000, 9790000000, 9810000000];
  for (const invalid of [undefined, 'not-a-time']) {
    const batches = prices.map((p, seq) => makeBatch(seq, p));
    const finalBatch = batches.at(-1);
    if (invalid === undefined) delete finalBatch.t;
    else finalBatch.t = invalid;
    const input = [hello, ...batches, done].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
    const replies = run.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies.at(-1).orders, []);
  }
});

test('does not emit orders when batch.seq is malformed', () => {
  const prices = [...Array(60).fill(10000000000), 9700000000, 9790000000, 9810000000];
  const batches = prices.map((p, seq) => makeBatch(seq, p));
  batches.at(-1).seq = 'not-a-sequence';
  const input = [hello, ...batches, done].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.at(-1).orders, []);
});

test('buys a moderate pullback after a 0.5% confirmed rebound', () => {
  const prices = [...Array(60).fill(10000000000), 9800000000, 9820000000, 9850000000];
  const messages = [hello, ...prices.map((p, seq) => makeBatch(seq, p)), done];
  const input = messages.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.at(-1).orders[0]?.side, 'buy');
});

test('sells the whole position after the rebound target fills', () => {
  const prices = [...Array(60).fill(10000000000), 9700000000, 9790000000, 9810000000];
  const position = { symbol: 'CBBTC', qty: '713557594', cost_quote_units: '700000000' };
  const fill = { client_id: 'buy-62', symbol: 'CBBTC', side: 'buy', status: 'filled', reason: null, decided_bar: 62, fill_bar: 63, price: '9810000000', qty: position.qty, notional_quote_units: '700000000', fee_quote_units: '560000' };
  const fillBatch = makeBatch(63, 9810000000, '300000000', [position]);
  fillBatch.fills = [fill];
  const targetBatch = makeBatch(64, 9900000000, '300000000', [position]);
  const messages = [hello, ...prices.map((p, seq) => makeBatch(seq, p)), fillBatch, targetBatch, done];
  const input = messages.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = spawnSync(process.execPath, [main], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || 'bot exited nonzero');
  const replies = run.stdout.trim().split('\n').map(JSON.parse);
  const order = replies.at(-1).orders[0];
  assert.equal(order?.side, 'sell');
  assert.equal(order?.qty, position.qty);
});

