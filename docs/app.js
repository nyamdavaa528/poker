// docs/app.js
const socket = io(window.SOCKET_URL, { transports: ["websocket", "polling"] });

// Screens
const screenEntry = document.getElementById("screenEntry");
const screenLobby = document.getElementById("screenLobby");
const screenGameGrid = document.getElementById("screenGameGrid");
const bottomBar = document.getElementById("bottomBar");

// Pills
const pillTable = document.getElementById("pillTable");
const pillRole = document.getElementById("pillRole");

// Entry
const tableIdEl = document.getElementById("tableId");
const nameEl = document.getElementById("name");
const entryErr = document.getElementById("entryErr");

// Lobby
const readyBtn = document.getElementById("readyBtn");
const startBtn = document.getElementById("startBtn");
const leaveBtn = document.getElementById("leaveBtn");
const lobbySeats = document.getElementById("lobbySeats");
const lobbyErr = document.getElementById("lobbyErr");
const lobbySettleBtn = document.getElementById("lobbySettleBtn");

// Game
const seatLayer = document.getElementById("seatLayer");
const potText = document.getElementById("potText");
const handMeta = document.getElementById("handMeta");
const historyDiv = document.getElementById("history");
const ledgerList = document.getElementById("ledgerList");
const turnBanner = document.getElementById("turnBanner");
const gameErr = document.getElementById("gameErr");

const actionStatus = document.getElementById("actionStatus");
const btnCall = document.getElementById("btnCall");
const btnRaise = document.getElementById("btnRaise");
const btnFold = document.getElementById("btnFold");
const btnWin = document.getElementById("btnWin");
const raiseInput = document.getElementById("raiseInput");

// Quick raise
const q500 = document.getElementById("q500");
const q1000 = document.getElementById("q1000");
const q1500 = document.getElementById("q1500");
const q2000 = document.getElementById("q2000");

const settleBtn = document.getElementById("settleBtn");
const backToLobbyBtn = document.getElementById("backToLobbyBtn");

// Identity
let mySeatIndex = null;
let myPlayerId = null;

// State
let state = null;

// Helpers
function show(el) {
  el.classList.remove("hide");
}
function hide(el) {
  el.classList.add("hide");
}
function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x.toLocaleString("en-US");
}
function setErr(el, msg) {
  if (!msg) {
    hide(el);
    el.textContent = "";
    return;
  }
  el.textContent = String(msg);
  show(el);
}
function clearAllErr() {
  setErr(entryErr, "");
  setErr(lobbyErr, "");
  setErr(gameErr, "");
}
function inGame(st) {
  return !!st?.hand;
}
function isHost(st) {
  return st?.hostSeatIndex === mySeatIndex;
}
function allReady(st) {
  const occ = st.seats.filter((s) => s.occupied);
  return occ.length >= 2 && occ.every((s) => s.ready);
}

// Raise input comma formatting
raiseInput.addEventListener("input", () => {
  const digits = raiseInput.value.replace(/[^\d]/g, "");
  if (!digits) {
    raiseInput.value = "";
    return;
  }
  const v = String(Number(digits));
  raiseInput.value = Number(v).toLocaleString("en-US");
});

// Actions
document.getElementById("createBtn").onclick = () => {
  clearAllErr();
  socket.emit("createTable", {
    tableId: tableIdEl.value.trim(),
    name: nameEl.value.trim(),
  });
};
document.getElementById("joinBtn").onclick = () => {
  clearAllErr();
  socket.emit("joinTable", {
    tableId: tableIdEl.value.trim(),
    name: nameEl.value.trim(),
  });
};

readyBtn.onclick = () => {
  clearAllErr();
  socket.emit("toggleReady");
};
leaveBtn.onclick = () => {
  socket.emit("leave");
  resetToEntry();
};

startBtn.onclick = () => {
  clearAllErr();
  socket.emit("startHand", { baseBet: 200 });
};

lobbySettleBtn.onclick = () => {
  clearAllErr();
  socket.emit("settlement");
};
settleBtn.onclick = () => {
  clearAllErr();
  socket.emit("settlement");
};

btnCall.onclick = () => {
  clearAllErr();
  socket.emit("call");
};
btnFold.onclick = () => {
  clearAllErr();
  socket.emit("fold");
};

btnRaise.onclick = () => {
  clearAllErr();
  const digits = raiseInput.value.replace(/[^\d]/g, "");
  const newBet = Number(digits);
  socket.emit("raise", { newBet });
  raiseInput.value = ""; // clear after raise
};

function quickRaise(amount) {
  clearAllErr();
  socket.emit("raise", { newBet: amount });
  raiseInput.value = "";
}
q500.onclick = () => quickRaise(500);
q1000.onclick = () => quickRaise(1000);
q1500.onclick = () => quickRaise(1500);
q2000.onclick = () => quickRaise(2000);

// Winner: host only, choose seat number (1-10)
btnWin.onclick = () => {
  clearAllErr();
  if (!state || !isHost(state)) return;

  const txt = prompt("Ялагчийн суудлын № (1-10):");
  if (txt === null) return;
  const n = Number(txt);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    setErr(gameErr, "1-10 хооронд суудлын дугаар оруулна уу.");
    return;
  }
  socket.emit("declareWinner", { winnerSeat: n - 1 });
};

backToLobbyBtn.onclick = () => {
  if (!state) return;
  renderScreens(state, { forceLobby: true });
};

// Socket events
socket.on("me", ({ seatIndex, playerId }) => {
  mySeatIndex = seatIndex;
  myPlayerId = playerId;
});

socket.on("errorMsg", ({ message }) => {
  if (!state) setErr(entryErr, message);
  else if (inGame(state)) setErr(gameErr, message);
  else setErr(lobbyErr, message);
});

socket.on("handFinished", ({ lastHand }) => {
  if (lastHand?.pot != null) {
    setErr(
      lobbyErr,
      `Гар дууслаа. Pot=${fmt(lastHand.pot)}. Бүгд Ready дарна.`
    );
    setTimeout(() => setErr(lobbyErr, ""), 3500);
  }
});

socket.on("settlementResult", ({ sum, transfers }) => {
  const lines = [];
  lines.push(`Net нийлбэр: ${fmt(sum)} (0 байх ёстой)`);
  if (!transfers?.length) lines.push("Тооцоо шаардлагагүй.");
  else {
    lines.push("Тооцоо:");
    for (const t of transfers)
      lines.push(`- ${t.from} → ${t.to}: ${fmt(t.amount)}`);
  }
  if (state && inGame(state)) setErr(gameErr, lines.join("\n"));
  else setErr(lobbyErr, lines.join("\n"));
});

socket.on("state", (st) => {
  state = st;
  pillTable.textContent = `Table: ${st.tableId}`;
  pillRole.textContent = `Role: ${isHost(st) ? "HOST" : "PLAYER"}`;
  renderScreens(st);
});

// Rendering
function resetToEntry() {
  state = null;
  mySeatIndex = null;
  myPlayerId = null;

  show(screenEntry);
  hide(screenLobby);
  hide(screenGameGrid);
  hide(bottomBar);

  pillTable.textContent = "Table: -";
  pillRole.textContent = "Role: -";
  clearAllErr();
}

function renderScreens(st, opts = {}) {
  const forceLobby = !!opts.forceLobby;

  if (!st) return resetToEntry();

  if (!inGame(st) || forceLobby) {
    hide(screenEntry);
    show(screenLobby);
    hide(screenGameGrid);
    hide(bottomBar);
    renderLobby(st);
    return;
  }

  hide(screenEntry);
  hide(screenLobby);
  show(screenGameGrid);
  show(bottomBar);
  renderGame(st);
}

function renderLobby(st) {
  lobbySeats.innerHTML = "";

  for (const s of st.seats) {
    const div = document.createElement("div");
    div.className = "seatMini";

    if (!s.occupied) {
      div.innerHTML = `<div class="n">Seat ${
        s.seat + 1
      }</div><div class="s">(empty)</div>`;
    } else {
      const tags = [];
      if (s.seat === st.hostSeatIndex)
        tags.push(`<span class="tag host">HOST</span>`);
      if (s.ready) tags.push(`<span class="tag ready">READY</span>`);
      if (s.seat === mySeatIndex) tags.push(`<span class="tag">ME</span>`);

      div.innerHTML = `
        <div class="n">${esc(s.name)} ${tags.join("")}</div>
        <div class="s">Seat ${s.seat + 1}</div>
      `;
    }
    lobbySeats.appendChild(div);
  }

  const canStart = isHost(st) && allReady(st);
  if (canStart) show(startBtn);
  else hide(startBtn);

  const me = st.seats.find((x) => x.seat === mySeatIndex);
  readyBtn.textContent = me?.ready ? "Ready (ON)" : "Ready";

  setErr(gameErr, "");
}

function renderGame(st) {
  const hand = st.hand;

  // center: only CURRENT
  potText.textContent = `Current: ${fmt(hand.currentBet)}`;
  handMeta.textContent = "";

  // Winner button only for host
  if (isHost(st)) show(btnWin);
  else hide(btnWin);

  // Seats (compact)
  seatLayer.innerHTML = "";
  for (const s of st.seats) {
    const seatIndex = s.seat;
    const seatDiv = document.createElement("div");
    seatDiv.className = `seat p${seatIndex}`;

    if (!s.occupied) {
      seatDiv.innerHTML = `<div class="name">Empty <span class="badge">${
        seatIndex + 1
      }</span></div>`;
      seatLayer.appendChild(seatDiv);
      continue;
    }

    const isDealer = hand.dealerSeat === seatIndex;
    const isTurn = hand.turnSeat === seatIndex;
    const isMe = seatIndex === mySeatIndex;
    const isFolded = !hand.inHand[seatIndex];

    if (isMe) seatDiv.classList.add("me");
    if (isTurn) seatDiv.classList.add("turn");
    if (isFolded) seatDiv.classList.add("folded");

    const badges = [];
    badges.push(`<span class="badge">${seatIndex + 1}</span>`);
    if (isDealer) badges.push(`<span class="badge dealer">D</span>`);
    if (isTurn) badges.push(`<span class="badge turn">T</span>`);

    seatDiv.innerHTML = `
      <div class="name">${esc(s.name)} ${badges.join("")}</div>
    `;
    seatLayer.appendChild(seatDiv);
  }

  // Turn / action status
  const myInHand = hand.inHand?.[mySeatIndex] === true;
  const myTurn = hand.turnSeat === mySeatIndex && myInHand;

  const currentBet = hand.currentBet ?? 0;
  const myContrib = hand.contributed?.[mySeatIndex] ?? 0;
  const callNeed = Math.max(0, currentBet - myContrib);

  if (myTurn) {
    turnBanner.textContent = `Таны ээлж. Call: ${fmt(
      callNeed
    )} | Current: ${fmt(currentBet)}`;
    show(turnBanner);
    actionStatus.textContent = `Таны ээлж — Call ${fmt(callNeed)}`;
  } else {
    hide(turnBanner);
    actionStatus.textContent = `Хүлээж байна… TURN: Seat ${hand.turnSeat + 1}`;
  }

  btnCall.disabled = !myTurn;
  btnFold.disabled = !myTurn;
  btnRaise.disabled = !myTurn;

  // quick buttons only on your turn
  q500.disabled = !myTurn;
  q1000.disabled = !myTurn;
  q1500.disabled = !myTurn;
  q2000.disabled = !myTurn;

  btnCall.textContent = callNeed > 0 ? `Call ${fmt(callNeed)}` : "Call";

  // Ledger
  ledgerList.innerHTML = "";
  for (const p of st.ledger) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.padding = "10px 0";
    row.style.borderBottom = "1px solid rgba(255,255,255,0.10)";
    const sign = p.net >= 0 ? "+" : "";
    row.innerHTML = `<div style="font-weight:900;">${esc(
      p.name
    )}</div><div style="font-weight:950;">${sign}${fmt(p.net)}</div>`;
    ledgerList.appendChild(row);
  }

  // History
  historyDiv.innerHTML = "";
  const hist = hand.history?.slice().reverse() || [];
  for (const h of hist.slice(0, 50)) {
    const t = new Date(h.ts).toLocaleString();
    const parts = [];
    parts.push(`[${t}]`);
    parts.push(esc(h.type));
    if (h.by) parts.push(`— <b>${esc(h.by)}</b>`);
    if (h.amount != null) parts.push(`(${fmt(h.amount)})`);
    if (h.newBet != null) parts.push(`→ ${fmt(h.newBet)}`);
    if (h.note) parts.push(`— ${esc(h.note)}`);
    const line = document.createElement("div");
    line.innerHTML = parts.join(" ");
    historyDiv.appendChild(line);
  }

  setErr(lobbyErr, "");
}

// Start
resetToEntry();
