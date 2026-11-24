// Trailblazer — a momentum-rotation paper bot for the pump.fun replay.
//
// Strategy in one breath: SPRAY EARLY, LET WINNERS RUN. Buy every coin the
// moment it shows its first real traction (real reserves cross 1.2 SOL —
// most coins never get there), a small uniform slice (at most 0.05 SOL, at
// least 0.011 SOL so the round trip counts). The stop is WIDE (-15%) on
// purpose: dev data shows the typical coin dips 15% before it rises 38%,
// so a tight stop just donates to fees. Take profit at +50%, with a
// trailing stop (15% off the peak once up 30%) so a mooner can run, and a
// long 7200-slot timeout. Each coin gets exactly one shot, at most 5 open
// at once, so the bot rotates across hundreds of coins and clears the
// 20-coin bar. Most pump.fun coins die; the few that moon pay for the rest.
//
// Protocol: agent-fun/replay/v2 over stdio. The harness sends hello, then
// batches (events + marks + fills + account), then done. We answer every
// batch with one reply echoing its seq. Marks arrive ONLY for coins we hold
// or have pending, so new coins are discovered through their trade events.
// All decisions come from the data in the messages; nothing random, no
// clock, no network, no files.

const SLIPPAGE_BPS = 1000; // 10%: pump.fun moves >3% in 2 slots constantly; a tight
// cap just gets orders rejected and leaves positions to the harness close
const TAKE_PROFIT_NUM = 150; // take profit at +50% over the entry mark
const TAKE_PROFIT_DEN = 100;
const STOP_NUM = 85; // wide stop at -15%: coins routinely dip -8% before rising
const STOP_DEN = 100;
const TRAIL_TRIGGER_NUM = 130; // trailing stop arms once up 30%
const TRAIL_TRIGGER_DEN = 100;
const TRAIL_DROP_NUM = 85; // sell once 15% off the peak
const TRAIL_DROP_DEN = 100;
const MAX_HOLD_SLOTS = 7200; // mooners get time; losers are cut by the stop
const MIN_BUY_LAMPORTS = 11_000_000n; // 0.011 SOL: above the 0.01 round-trip bar
const MAX_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL per position: small, uniform
const MIN_REAL_RESERVES = 1_200_000_000n; // first real traction: real reserves cross 1.2 SOL
const ENTRY_MIN_RISE_NUM = 102; // sanity: price at least +2% vs first sight
const ENTRY_MIN_RISE_DEN = 100;
const MIN_OBSERVE_SLOTS = 5; // watch a coin for at least 5 slots before entering
const HIST_CAP = 12; // keep only the last few trades per coin (bounded memory)
const MAX_NEW_BUYS_PER_BATCH = 2;

// --- price helpers: prices are ratios (quote per token), compared exactly ---
// Is price a/b at least (c/d) * (num/den)?  Cross-multiplied, all BigInt.
function atLeast(aQ, aT, bQ, bT, num, den) {
  return aQ * bT * BigInt(num) >= bQ * aT * BigInt(den);
}
// Is price a/b at most (c/d) * (num/den)?
function atMost(aQ, aT, bQ, bT, num, den) {
  return aQ * bT * BigInt(num) <= bQ * aT * BigInt(den);
}

const state = {
  cash: 0n,
  maxOpen: 5,
  maxOrderBps: 100,
  maxOrdersPerBatch: 16,
  // mint -> { firstQ, firstT, lastQ, lastT, lastReal, firstSlot, marks, trades, buyVol, sellVol, hist }
  // hist: last few trades as { q, t, buy, amt } (kept bounded; not used by the entry rule)
  coins: new Map(),
  // mint -> { tokens, cost, entryQ, entryT, peakQ, peakT, entrySlot }
  positions: new Map(),
  // clientId -> { mint, side, entryQ, entryT, entrySlot }
  pending: new Map(),
  done: new Set(), // coins already traded once: never re-enter
  orderSeq: 0,
};

function nextClientId() {
  state.orderSeq += 1;
  return "o" + state.orderSeq;
}

function openCount() {
  let n = state.positions.size;
  for (const p of state.pending.values()) if (p.side === "buy") n += 1;
  return n;
}

function reservedCash() {
  // Cash already spoken for by pending buys (their quote amounts are not
  // tracked here; buys are small and cash is checked again at send time).
  return 0n;
}

function foldFills(fills) {
  if (!Array.isArray(fills)) return;
  for (const f of fills) {
    const p = state.pending.get(f.client_id);
    if (f.client_id.startsWith("_")) {
      // A harness close (complete / flatten / writeoff): the account in this
      // same batch already reflects it; just forget any pending record.
      if (p) state.pending.delete(f.client_id);
      if (f.mint) state.done.add(f.mint);
      continue;
    }
    if (!p) continue;
    state.pending.delete(f.client_id);
    if (f.status === "filled" && p.side === "buy") {
      // The position itself arrives via the batch account below; keep the
      // entry reference so the account sync can attach it.
      state.positions.set(p.mint, {
        tokens: 0n,
        cost: 0n,
        entryQ: p.entryQ,
        entryT: p.entryT,
        peakQ: p.entryQ,
        peakT: p.entryT,
        entrySlot: p.entrySlot,
        awaitingFill: true,
      });
    } else if (f.status === "filled" && p.side === "sell") {
      state.done.add(p.mint);
    } else {
      // rejected or failed: one shot per coin, do not retry this mint.
      state.done.add(p.mint);
    }
  }
}

function syncAccount(account) {
  if (!account) return;
  state.cash = BigInt(account.cash_lamports || "0");
  const live = new Map();
  for (const pos of account.positions || []) {
    const mint = pos.mint;
    const old = state.positions.get(mint);
    const coin = state.coins.get(mint);
    let entryQ, entryT, peakQ, peakT, entrySlot;
    if (old && !old.awaitingFill) {
      entryQ = old.entryQ; entryT = old.entryT;
      peakQ = old.peakQ; peakT = old.peakT;
      entrySlot = old.entrySlot;
    } else if (old && old.awaitingFill) {
      entryQ = old.entryQ; entryT = old.entryT;
      peakQ = old.entryQ; peakT = old.entryT;
      entrySlot = old.entrySlot;
    } else if (coin) {
      entryQ = coin.lastQ; entryT = coin.lastT;
      peakQ = coin.lastQ; peakT = coin.lastT;
      entrySlot = 0;
    } else {
      // No record at all: use the average buy price as the reference.
      entryQ = BigInt(pos.cost_lamports || "1");
      entryT = BigInt(pos.token_amount || "1");
      peakQ = entryQ; peakT = entryT;
      entrySlot = 0;
    }
    live.set(mint, {
      tokens: BigInt(pos.token_amount || "0"),
      cost: BigInt(pos.cost_lamports || "0"),
      entryQ, entryT, peakQ, peakT, entrySlot,
    });
  }
  state.positions = live;
}

function foldMarks(marks, slot) {
  if (!Array.isArray(marks)) return;
  for (const m of marks) {
    const q = BigInt(m.virtual_quote_reserves || "0");
    const t = BigInt(m.virtual_token_reserves || "0");
    if (t === 0n) continue;
    let c = state.coins.get(m.mint);
    if (!c) {
      c = {
        firstQ: q, firstT: t, lastQ: q, lastT: t, lastReal: 0n,
        firstSlot: slot, marks: 0, trades: 0, buyVol: 0n, sellVol: 0n, hist: [],
      };
      state.coins.set(m.mint, c);
    }
    c.lastQ = q; c.lastT = t; c.marks += 1;
    // Keep the peak of every held position current.
    const pos = state.positions.get(m.mint);
    if (pos && atLeast(q, t, pos.peakQ, pos.peakT, 1, 1)) {
      pos.peakQ = q; pos.peakT = t;
    }
  }
}

function foldEvents(events, slot) {
  if (!Array.isArray(events)) return;
  for (const e of events) {
    if (e.event === "TradeEvent") {
      const q = BigInt(e.virtual_sol_reserves || "0");
      const t = BigInt(e.virtual_token_reserves || "0");
      let c = state.coins.get(e.mint);
      if (!c) {
        c = {
          firstQ: q, firstT: t, lastQ: q, lastT: t, lastReal: 0n,
          firstSlot: slot, marks: 0, trades: 0, buyVol: 0n, sellVol: 0n, hist: [],
        };
        state.coins.set(e.mint, c);
      }
      if (t !== 0n) { c.lastQ = q; c.lastT = t; }
      c.lastReal = BigInt(e.real_sol_reserves || "0");
      c.trades += 1;
      const amt = BigInt(e.sol_amount || "0");
      if (e.is_buy) c.buyVol += amt; else c.sellVol += amt;
      c.hist.push({ q, t, buy: !!e.is_buy, amt });
      if (c.hist.length > HIST_CAP) c.hist.shift();
      // Keep a held position's peak current from trade flow too.
      const pos = state.positions.get(e.mint);
      if (pos && t !== 0n && atLeast(q, t, pos.peakQ, pos.peakT, 1, 1)) {
        pos.peakQ = q; pos.peakT = t;
      }
    } else if (e.event === "CreateEvent") {
      if (!state.coins.has(e.mint)) {
        const q = BigInt(e.virtual_sol_reserves || "0");
        const t = BigInt(e.virtual_token_reserves || "0");
        state.coins.set(e.mint, {
          firstQ: q, firstT: t, lastQ: q, lastT: t, lastReal: 0n,
          firstSlot: slot, marks: 0, trades: 0, buyVol: 0n, sellVol: 0n, hist: [],
        });
      }
    }
  }
}

function decide(batch) {
  const orders = [];
  const slot = batch.slot || 0;
  const completed = new Set();
  for (const e of batch.events || []) {
    if (e.event === "CompleteEvent" && state.positions.has(e.mint)) {
      completed.add(e.mint);
    }
  }

  // --- exits first: take profit, stop loss, trailing stop, timeout, completion
  for (const [mint, pos] of state.positions) {
    if (pos.tokens === 0n) continue;
    const coin = state.coins.get(mint);
    if (!coin) continue;
    const q = coin.lastQ, t = coin.lastT;
    let sell = completed.has(mint);
    if (!sell && atLeast(q, t, pos.entryQ, pos.entryT, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN)) sell = true;
    if (!sell && atMost(q, t, pos.entryQ, pos.entryT, STOP_NUM, STOP_DEN)) sell = true;
    if (!sell && atLeast(pos.peakQ, pos.peakT, pos.entryQ, pos.entryT, TRAIL_TRIGGER_NUM, TRAIL_TRIGGER_DEN)
      && atMost(q, t, pos.peakQ, pos.peakT, TRAIL_DROP_NUM, TRAIL_DROP_DEN)) sell = true;
    if (!sell && pos.entrySlot > 0 && slot - pos.entrySlot > MAX_HOLD_SLOTS) sell = true;
    if (sell) {
      const id = nextClientId();
      state.pending.set(id, { mint, side: "sell", entryQ: pos.entryQ, entryT: pos.entryT, entrySlot: pos.entrySlot });
      orders.push({ side: "sell", client_id: id, mint, token_amount: pos.tokens.toString(), max_slippage_bps: SLIPPAGE_BPS });
    }
  }

  // --- entries: first real traction, one shot per coin.
  // Candidates come from this batch's TRADE events, not from marks: the
  // harness only sends marks for coins we already hold or have pending, so
  // a new coin can only be discovered through its trades.
  let buys = 0;
  if (openCount() < state.maxOpen) {
    const candidates = [];
    const seen = new Set();
    for (const e of batch.events || []) {
      if (e.event === "TradeEvent" && !seen.has(e.mint)) {
        seen.add(e.mint);
        candidates.push(e.mint);
      }
    }
    for (const mint of candidates) {
      if (buys >= MAX_NEW_BUYS_PER_BATCH) break;
      if (orders.length >= state.maxOrdersPerBatch) break;
      if (openCount() >= state.maxOpen) break;
      if (state.positions.has(mint) || state.done.has(mint)) continue;
      let hasPending = false;
      for (const p of state.pending.values()) if (p.mint === mint) { hasPending = true; break; }
      if (hasPending) continue;
      const c = state.coins.get(mint);
      if (!c || c.trades < 2) continue;
      if (slot - c.firstSlot < MIN_OBSERVE_SLOTS) continue;
      // First real traction: real reserves crossed 1.2 SOL and the price is
      // at least a touch above first sight. No momentum filter — most coins
      // never get here, and the ones that do are the whole opportunity set.
      if (!atLeast(c.lastQ, c.lastT, c.firstQ, c.firstT, ENTRY_MIN_RISE_NUM, ENTRY_MIN_RISE_DEN)) continue;
      const real = c.lastReal;
      if (real < MIN_REAL_RESERVES) continue;
      // Cap: 0.9% of real reserves (the harness allows 1%), at most 0.3 SOL.
      let size = (real * 9n) / 1000n;
      if (size > MAX_BUY_LAMPORTS) size = MAX_BUY_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (size > state.cash - reservedCash()) continue;
      const id = nextClientId();
      state.pending.set(id, { mint, side: "buy", entryQ: c.lastQ, entryT: c.lastT, entrySlot: slot });
      orders.push({ side: "buy", client_id: id, mint, quote_lamports: size.toString(), max_slippage_bps: SLIPPAGE_BPS });
      buys += 1;
    }
  }
  return orders;
}

function onHello(hello) {
  if (hello.capital) state.cash = BigInt(hello.capital.lamports || "0");
  if (hello.caps) {
    state.maxOpen = hello.caps.max_open_positions || 5;
    state.maxOrderBps = hello.caps.max_order_bps_of_real_reserve || 100;
    state.maxOrdersPerBatch = hello.caps.max_orders_per_batch || 16;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "hello") {
      onHello(msg);
    } else if (msg.type === "batch") {
      foldFills(msg.fills);
      syncAccount(msg.account);
      foldMarks(msg.marks, msg.slot || 0);
      foldEvents(msg.events, msg.slot || 0);
      const orders = decide(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    } else if (msg.type === "done") {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
