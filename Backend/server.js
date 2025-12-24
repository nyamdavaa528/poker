import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// IMPORTANT: set ALLOWED_ORIGIN in Render env to your GitHub Pages origin.
// Example: https://yourname.github.io
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

const io = new Server(server, {
  cors: {
    origin: allowedOrigin === "*" ? "*" : [allowedOrigin],
    methods: ["GET", "POST"],
  },
});

// -------- Data model --------
const tables = new Map();

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function makeTable(tableId, hostSocketId, maxSeats = 10) {
  const seats = Array.from({ length: maxSeats }, () => null);
  const ledger = new Map();
  const table = {
    tableId,
    maxSeats,
    createdAt: Date.now(),
    hostSocketId,
    seats,
    hand: null,
    ledger, // Map<playerId, net>
  };
  tables.set(tableId, table);
  return table;
}

function getTable(tableId) {
  return tables.get(tableId);
}

function nextOccupiedSeat(table, fromSeat) {
  const n = table.maxSeats;
  for (let step = 1; step <= n; step++) {
    const i = (fromSeat + step) % n;
    if (table.seats[i]) return i;
  }
  return -1;
}

function ensureHost(table, socketId) {
  return table.hostSocketId === socketId;
}

function seatPlayer(table, socket, name, seatIndex) {
  const playerId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  table.seats[seatIndex] = {
    playerId,
    name,
    socketId: socket.id,
    ready: false,
  };
  if (!table.ledger.has(playerId)) table.ledger.set(playerId, 0);

  socket.data.tableId = table.tableId;
  socket.data.playerId = playerId;
  socket.data.seatIndex = seatIndex;

  return { playerId, seatIndex };
}

function tableSnapshot(table) {
  const seats = table.seats.map((s, idx) => {
    if (!s) return { seat: idx, occupied: false };
    return {
      seat: idx,
      occupied: true,
      name: s.name,
      ready: !!s.ready,
    };
  });

  let hostSeatIndex = -1;
  for (let i = 0; i < table.maxSeats; i++) {
    if (table.seats[i] && table.seats[i].socketId === table.hostSocketId) {
      hostSeatIndex = i;
      break;
    }
  }

  const ledgerArr = [];
  for (const seat of table.seats) {
    if (!seat) continue;
    ledgerArr.push({
      name: seat.name,
      net: table.ledger.get(seat.playerId) ?? 0,
      playerId: seat.playerId,
    });
  }
  ledgerArr.sort((a, b) => b.net - a.net);

  const hand = table.hand
    ? {
        id: table.hand.id,
        dealerSeat: table.hand.dealerSeat,
        turnSeat: table.hand.turnSeat,
        baseBet: table.hand.baseBet,
        currentBet: table.hand.currentBet,
        pot: table.hand.pot,
        inHand: table.hand.inHand,
        contributed: table.hand.contributed,
        history: table.hand.history.slice(-200),
      }
    : null;

  return {
    tableId: table.tableId,
    maxSeats: table.maxSeats,
    hostSeatIndex,
    seats,
    hand,
    ledger: ledgerArr,
  };
}

function allReady(table) {
  const occ = [];
  for (let i = 0; i < table.maxSeats; i++) if (table.seats[i]) occ.push(i);
  if (occ.length < 2) return false;
  for (const i of occ) if (!table.seats[i].ready) return false;
  return true;
}

function startHand(table, baseBet = 200) {
  const occupiedSeats = [];
  for (let i = 0; i < table.maxSeats; i++)
    if (table.seats[i]) occupiedSeats.push(i);
  if (occupiedSeats.length < 2) throw new Error("At least 2 players required.");
  if (!allReady(table)) throw new Error("All players must be Ready.");

  const dealerSeat = table.hand
    ? nextOccupiedSeat(table, table.hand.dealerSeat)
    : occupiedSeats[randInt(occupiedSeats.length)];

  const inHand = Array.from({ length: table.maxSeats }, () => false);
  const contributed = Array.from({ length: table.maxSeats }, () => 0);
  for (const i of occupiedSeats) inHand[i] = true;

  const b = Number(baseBet) || 200;
  const turnSeat = nextOccupiedSeat(table, dealerSeat);

  table.hand = {
    id: `${Date.now()}`,
    dealerSeat,
    turnSeat,
    baseBet: b,
    currentBet: b,
    pot: 0,
    inHand,
    contributed,
    history: [
      { ts: Date.now(), type: "start", note: `Hand started. Base=${b}` },
    ],
  };
}

function applyCall(table, seatIndex) {
  const hand = table.hand;
  const seat = table.seats[seatIndex];
  if (!hand || !seat) return;

  const need = hand.currentBet - hand.contributed[seatIndex];
  const pay = Math.max(0, need);

  hand.contributed[seatIndex] += pay;
  hand.pot += pay;

  hand.history.push({
    ts: Date.now(),
    type: "call",
    by: seat.name,
    amount: pay,
    currentBet: hand.currentBet,
  });
}

function applyRaise(table, seatIndex, newBet) {
  const hand = table.hand;
  const seat = table.seats[seatIndex];
  if (!hand || !seat) return;

  const nb = Number(newBet);
  if (!Number.isFinite(nb) || nb <= hand.currentBet)
    throw new Error("Raise must be greater than current bet.");

  const need = nb - hand.contributed[seatIndex];
  if (need < 0) throw new Error("Invalid raise state.");

  hand.currentBet = nb;
  hand.contributed[seatIndex] += need;
  hand.pot += need;

  hand.history.push({
    ts: Date.now(),
    type: "raise",
    by: seat.name,
    amount: need,
    newBet: nb,
  });
}

function applyFold(table, seatIndex) {
  const hand = table.hand;
  const seat = table.seats[seatIndex];
  if (!hand || !seat) return;

  hand.inHand[seatIndex] = false;
  hand.history.push({ ts: Date.now(), type: "fold", by: seat.name });
}

function advanceTurnOrAutoFinish(table) {
  const hand = table.hand;
  if (!hand) return { finished: false, lastHand: null };

  // alive seats
  const alive = [];
  for (let i = 0; i < table.maxSeats; i++) {
    if (table.seats[i] && hand.inHand[i]) alive.push(i);
  }

  if (alive.length === 1) {
    const lastHand = finishHand(table, alive[0], "auto (only player left)");
    return { finished: true, lastHand };
  }

  const t = hand.turnSeat;
  for (let step = 1; step <= table.maxSeats; step++) {
    const i = (t + step) % table.maxSeats;
    if (table.seats[i] && hand.inHand[i]) {
      hand.turnSeat = i;
      return { finished: false, lastHand: null };
    }
  }
  return { finished: false, lastHand: null };
}

function finishHand(table, winnerSeat, note = "") {
  const hand = table.hand;
  const winner = table.seats[winnerSeat];
  if (!hand || !winner) return null;

  // everyone pays contributed (negative)
  for (let i = 0; i < table.maxSeats; i++) {
    const s = table.seats[i];
    if (!s) continue;
    const paid = hand.contributed[i] || 0;
    if (paid !== 0)
      table.ledger.set(s.playerId, (table.ledger.get(s.playerId) ?? 0) - paid);
  }
  // winner receives pot (positive)
  table.ledger.set(
    winner.playerId,
    (table.ledger.get(winner.playerId) ?? 0) + hand.pot
  );

  hand.history.push({
    ts: Date.now(),
    type: "win",
    by: winner.name,
    pot: hand.pot,
    note,
  });

  // reset ready
  for (let i = 0; i < table.maxSeats; i++)
    if (table.seats[i]) table.seats[i].ready = false;

  const lastHand = table.hand;
  table.hand = null;
  return lastHand;
}

function computeSettlement(ledgerArr) {
  const creditors = ledgerArr.filter((p) => p.net > 0).map((p) => ({ ...p }));
  const debtors = ledgerArr
    .filter((p) => p.net < 0)
    .map((p) => ({ name: p.name, owed: -p.net }));

  const transfers = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amt = Math.min(d.owed, c.net);
    transfers.push({ from: d.name, to: c.name, amount: amt });
    d.owed -= amt;
    c.net -= amt;
    if (d.owed === 0) i++;
    if (c.net === 0) j++;
  }
  return transfers;
}

function cleanupIfEmpty(tableId) {
  const table = getTable(tableId);
  if (!table) return;
  const any = table.seats.some((s) => s !== null);
  if (!any) tables.delete(tableId);
}

function reassignHostIfNeeded(table, leavingSocketId) {
  if (table.hostSocketId !== leavingSocketId) return;
  const first = table.seats.find((s) => s !== null);
  table.hostSocketId = first ? first.socketId : null;
}

// -------- Socket handlers --------
io.on("connection", (socket) => {
  socket.on("createTable", ({ tableId, name }) => {
    try {
      tableId = String(tableId || "").trim();
      name = String(name || "").trim();
      if (!tableId || !name) throw new Error("Table ID and name required.");
      if (tables.has(tableId)) throw new Error("Table already exists.");

      const table = makeTable(tableId, socket.id, 10);
      const { playerId, seatIndex } = seatPlayer(table, socket, name, 0);

      socket.join(tableId);
      socket.emit("me", { tableId, seatIndex, playerId, isHost: true });

      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Create failed" });
    }
  });

  socket.on("joinTable", ({ tableId, name }) => {
    try {
      tableId = String(tableId || "").trim();
      name = String(name || "").trim();
      if (!tableId || !name) throw new Error("Table ID and name required.");

      const table = getTable(tableId);
      if (!table) throw new Error("Table not found.");

      const seatIndex = table.seats.findIndex((s) => s === null);
      if (seatIndex === -1) throw new Error("Table is full (10).");

      const { playerId } = seatPlayer(table, socket, name, seatIndex);

      socket.join(tableId);
      socket.emit("me", { tableId, seatIndex, playerId, isHost: false });

      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Join failed" });
    }
  });

  socket.on("toggleReady", () => {
    try {
      const { tableId, seatIndex } = socket.data;
      const table = getTable(tableId);
      if (!table) throw new Error("Not in a table.");
      const seat = table.seats?.[seatIndex];
      if (!seat) throw new Error("Seat missing.");
      if (seat.socketId !== socket.id)
        throw new Error("Seat ownership mismatch.");
      if (table.hand) throw new Error("Hand is active. (Finish hand first)");

      seat.ready = !seat.ready;
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Ready failed" });
    }
  });

  socket.on("startHand", ({ baseBet }) => {
    try {
      const { tableId } = socket.data;
      const table = getTable(tableId);
      if (!table) throw new Error("Not in a table.");
      if (!ensureHost(table, socket.id))
        throw new Error("Only host can start.");
      if (table.hand) throw new Error("Hand already active.");

      startHand(table, Number(baseBet) || 200);
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Start failed" });
    }
  });

  socket.on("call", () => {
    try {
      const { tableId, seatIndex } = socket.data;
      const table = getTable(tableId);
      if (!table || !table.hand) throw new Error("No active hand.");
      if (table.hand.turnSeat !== seatIndex) throw new Error("Not your turn.");
      if (!table.hand.inHand[seatIndex]) throw new Error("You are folded.");

      applyCall(table, seatIndex);
      const r = advanceTurnOrAutoFinish(table);

      if (r.finished)
        io.to(tableId).emit("handFinished", { lastHand: r.lastHand });
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Call failed" });
    }
  });

  socket.on("raise", ({ newBet }) => {
    try {
      const { tableId, seatIndex } = socket.data;
      const table = getTable(tableId);
      if (!table || !table.hand) throw new Error("No active hand.");
      if (table.hand.turnSeat !== seatIndex) throw new Error("Not your turn.");
      if (!table.hand.inHand[seatIndex]) throw new Error("You are folded.");

      applyRaise(table, seatIndex, newBet);
      const r = advanceTurnOrAutoFinish(table);

      if (r.finished)
        io.to(tableId).emit("handFinished", { lastHand: r.lastHand });
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Raise failed" });
    }
  });

  socket.on("fold", () => {
    try {
      const { tableId, seatIndex } = socket.data;
      const table = getTable(tableId);
      if (!table || !table.hand) throw new Error("No active hand.");
      if (table.hand.turnSeat !== seatIndex) throw new Error("Not your turn.");
      if (!table.hand.inHand[seatIndex]) throw new Error("Already folded.");

      applyFold(table, seatIndex);
      const r = advanceTurnOrAutoFinish(table);

      if (r.finished)
        io.to(tableId).emit("handFinished", { lastHand: r.lastHand });
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Fold failed" });
    }
  });

  // WINNER: host only, choose winner seat
  socket.on("declareWinner", ({ winnerSeat }) => {
    try {
      const { tableId } = socket.data;
      const table = getTable(tableId);
      if (!table || !table.hand) throw new Error("No active hand.");
      if (!ensureHost(table, socket.id))
        throw new Error("Only HOST can declare winner.");

      const ws = Number(winnerSeat);
      if (!Number.isInteger(ws) || ws < 0 || ws >= table.maxSeats)
        throw new Error("Invalid winner seat.");
      if (!table.seats[ws]) throw new Error("Winner seat is empty.");
      if (!table.hand.inHand[ws]) throw new Error("Winner is folded.");

      const lastHand = finishHand(table, ws, "declared by HOST");
      io.to(tableId).emit("handFinished", { lastHand });
      io.to(tableId).emit("state", tableSnapshot(table));
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Winner failed" });
    }
  });

  socket.on("settlement", () => {
    try {
      const { tableId } = socket.data;
      const table = getTable(tableId);
      if (!table) throw new Error("Not in a table.");

      const ledgerArr = [];
      for (const seat of table.seats) {
        if (!seat) continue;
        ledgerArr.push({
          name: seat.name,
          net: table.ledger.get(seat.playerId) ?? 0,
        });
      }
      const sum = ledgerArr.reduce((a, b) => a + b.net, 0);
      const transfers = computeSettlement(ledgerArr);

      io.to(tableId).emit("settlementResult", { sum, transfers });
    } catch (e) {
      socket.emit("errorMsg", { message: e?.message || "Settlement failed" });
    }
  });

  socket.on("leave", () => {
    const { tableId, seatIndex } = socket.data;
    const table = getTable(tableId);
    if (!table) return;

    if (
      seatIndex !== undefined &&
      table.seats[seatIndex]?.socketId === socket.id
    ) {
      // If active hand and in-hand, fold them
      if (table.hand && table.hand.inHand?.[seatIndex]) {
        table.hand.inHand[seatIndex] = false;
        table.hand.history.push({
          ts: Date.now(),
          type: "leave-fold",
          by: "system",
          note: `Seat ${seatIndex + 1} left`,
        });
        if (table.hand.turnSeat === seatIndex) advanceTurnOrAutoFinish(table);
      }
      table.seats[seatIndex] = null;
    }

    socket.leave(tableId);
    socket.data.tableId = null;
    socket.data.playerId = null;
    socket.data.seatIndex = null;

    reassignHostIfNeeded(table, socket.id);
    cleanupIfEmpty(tableId);

    if (tables.has(tableId)) io.to(tableId).emit("state", tableSnapshot(table));
  });

  socket.on("disconnect", () => {
    const { tableId, seatIndex } = socket.data;
    const table = getTable(tableId);
    if (!table) return;

    if (
      seatIndex !== undefined &&
      table.seats[seatIndex]?.socketId === socket.id
    ) {
      if (table.hand && table.hand.inHand?.[seatIndex]) {
        table.hand.inHand[seatIndex] = false;
        table.hand.history.push({
          ts: Date.now(),
          type: "disconnect-fold",
          by: "system",
          note: `Seat ${seatIndex + 1} dc`,
        });
        if (table.hand.turnSeat === seatIndex) advanceTurnOrAutoFinish(table);
      }
      table.seats[seatIndex] = null;
    }

    reassignHostIfNeeded(table, socket.id);
    cleanupIfEmpty(tableId);

    if (tables.has(tableId)) io.to(tableId).emit("state", tableSnapshot(table));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Backend running on :${PORT}, ALLOWED_ORIGIN=${allowedOrigin}`)
);
