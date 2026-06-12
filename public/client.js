const socket = io();

const HAND_LABELS = {
  rock: "グー",
  scissors: "チョキ",
  paper: "パー",
};

const COLOR_LABELS = {
  white: "白",
  blue: "青",
  red: "赤",
};

const COLOR_SCORE = {
  white: 1,
  blue: 2,
  red: 3,
};

const els = {
  joinView: document.getElementById("joinView"),
  waitingView: document.getElementById("waitingView"),
  gameView: document.getElementById("gameView"),
  nameInput: document.getElementById("nameInput"),
  joinButton: document.getElementById("joinButton"),
  leaveButton: document.getElementById("leaveButton"),
  waitingMessage: document.getElementById("waitingMessage"),
  waitingBar: document.getElementById("waitingBar"),
  waitingPlayers: document.getElementById("waitingPlayers"),
  roundBadge: document.getElementById("roundBadge"),
  connectionBadge: document.getElementById("connectionBadge"),
  scoreBoard: document.getElementById("scoreBoard"),
  orderList: document.getElementById("orderList"),
  mainMessage: document.getElementById("mainMessage"),
  submittedArea: document.getElementById("submittedArea"),
  revealArea: document.getElementById("revealArea"),
  revealCards: document.getElementById("revealCards"),
  handTitle: document.getElementById("handTitle"),
  handCards: document.getElementById("handCards"),
  afterGame: document.getElementById("afterGame"),
  backLobbyButton: document.getElementById("backLobbyButton"),
  rematchButton: document.getElementById("rematchButton"),
  toast: document.getElementById("toast"),
};

let myName = localStorage.getItem("threecolorjanken.name") || "";
let toastTimer = null;

els.nameInput.value = myName;

function show(view) {
  els.joinView.classList.toggle("hidden", view !== "join");
  els.waitingView.classList.toggle("hidden", view !== "waiting");
  els.gameView.classList.toggle("hidden", view !== "game");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function joinQueue() {
  const name = (els.nameInput.value || "").trim() || "名無し";
  myName = name.slice(0, 16);
  localStorage.setItem("threecolorjanken.name", myName);
  socket.emit("join-queue", { name: myName });
  show("waiting");
}

function leaveQueue() {
  socket.emit("leave-queue");
  show("join");
}

function visibleNow() {
  return document.visibilityState === "visible";
}

function sendHeartbeat() {
  if (socket.connected) {
    socket.emit("heartbeat", { visible: visibleNow() });
  }
}

setInterval(sendHeartbeat, 4_000);
document.addEventListener("visibilitychange", sendHeartbeat);
window.addEventListener("focus", sendHeartbeat);
window.addEventListener("beforeunload", () => {
  socket.emit("leave-queue");
});

els.joinButton.addEventListener("click", joinQueue);
els.nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinQueue();
});
els.leaveButton.addEventListener("click", leaveQueue);

els.backLobbyButton.addEventListener("click", () => {
  socket.emit("return-lobby");
  show("join");
});

els.rematchButton.addEventListener("click", () => {
  socket.emit("return-lobby");
  els.nameInput.value = myName;
  joinQueue();
});

socket.on("connect", () => {
  els.connectionBadge.textContent = "ONLINE";
  sendHeartbeat();
});

socket.on("disconnect", () => {
  els.connectionBadge.textContent = "OFFLINE";
  toast("サーバーとの接続が切れました。");
});

socket.on("connect_error", () => {
  toast("接続できません。サーバーが起動しているか確認してください。");
});

socket.on("error-message", (message) => {
  toast(message);
});

socket.on("waiting", (payload) => {
  els.waitingMessage.textContent = payload.message;
  show("waiting");
});

socket.on("queue-removed", ({ reason }) => {
  if (reason === "left") return;
  const message = reason === "inactive"
    ? "待機中にタブが非表示のままだったため、待機から外しました。"
    : "接続が不安定だったため、待機から外しました。";
  toast(message);
  show("join");
});

socket.on("lobby-state", (state) => {
  renderLobby(state);
});

socket.on("matched", () => {
  show("game");
  toast("3人そろいました。対戦開始。");
});

socket.on("game-state", (game) => {
  show("game");
  renderGame(game);
});

function renderLobby(state) {
  const count = state?.count ?? 0;
  const required = state?.required ?? 3;
  const percentage = Math.min(100, Math.round((count / required) * 100));

  els.waitingBar.style.width = `${percentage}%`;
  els.waitingMessage.textContent = `${count} / ${required} 人が待機中です。`;

  els.waitingPlayers.innerHTML = "";
  for (const player of state?.players ?? []) {
    const li = document.createElement("li");
    li.textContent = player.name;
    els.waitingPlayers.appendChild(li);
  }
}

function renderGame(game) {
  els.roundBadge.textContent = game.status === "ended"
    ? "GAME SET"
    : game.status === "aborted"
      ? "ABORTED"
      : `ROUND ${game.round} / ${game.maxRounds}`;

  renderScores(game);
  renderOrder(game);
  renderSubmissions(game);
  renderReveal(game);
  renderHand(game);

  els.afterGame.classList.toggle("hidden", !(game.status === "ended" || game.status === "aborted"));

  if (game.status === "aborted") {
    els.mainMessage.textContent = game.reveal?.message ?? "切断によりゲームを終了しました。";
    return;
  }

  if (game.status === "ended") {
    const winners = getWinnerNames(game.reveal?.rankings ?? []);
    els.mainMessage.textContent = `ゲーム終了。勝者: ${winners}`;
    return;
  }

  if (game.phase === "reveal") {
    els.mainMessage.textContent = `${game.reveal?.message ?? "公開中"}\n次の順番: ${namesByOrder(game, game.reveal?.nextOrder ?? game.order).join(" → ")}`;
    return;
  }

  const current = getPlayer(game, game.currentPlayerId);
  if (game.currentPlayerId === game.viewerId) {
    els.mainMessage.textContent = "あなたの番です。カードを1枚選んでください。";
  } else {
    els.mainMessage.textContent = `${current?.name ?? "相手"} の番です。色だけ見て待ちましょう。`;
  }
}

function renderScores(game) {
  els.scoreBoard.innerHTML = "";
  for (const player of game.players) {
    const div = document.createElement("div");
    div.className = "score-card";
    if (player.id === game.currentPlayerId && game.phase === "playing") {
      div.classList.add("current");
    }

    div.innerHTML = `
      <div class="score-name">${escapeHtml(player.name)}</div>
      <div class="score-value">${player.score} 点</div>
      <div class="score-small">残り ${player.cardCount} 枚 ${player.connected ? "" : " / 切断"}</div>
    `;

    els.scoreBoard.appendChild(div);
  }
}

function renderOrder(game) {
  els.orderList.innerHTML = "";
  for (const playerId of game.order) {
    const player = getPlayer(game, playerId);
    const li = document.createElement("li");
    li.textContent = player?.name ?? "不明";
    if (playerId === game.currentPlayerId && game.phase === "playing") {
      li.classList.add("active");
    }
    els.orderList.appendChild(li);
  }
}

function renderSubmissions(game) {
  els.submittedArea.innerHTML = "";

  for (const submission of game.submissions) {
    const player = getPlayer(game, submission.playerId);
    const div = document.createElement("div");
    div.className = "submitted-chip";
    const cardText = submission.revealed
      ? `${submission.colorLabel}${submission.handLabel}`
      : `${submission.colorLabel}？`;

    div.innerHTML = `
      <div>${escapeHtml(player?.name ?? "不明")}</div>
      <span class="color-chip color-${submission.color}">${escapeHtml(cardText)}</span>
    `;
    els.submittedArea.appendChild(div);
  }
}

function renderReveal(game) {
  const showReveal = game.phase === "reveal" || game.phase === "ended";
  els.revealArea.classList.toggle("hidden", !showReveal);
  els.revealCards.innerHTML = "";

  const entries = game.reveal?.entries ?? [];
  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = `reveal-card color-${entry.color}`;
    card.innerHTML = `
      <div>${escapeHtml(entry.name)}</div>
      <span class="card-hand">${escapeHtml(entry.colorLabel)}${escapeHtml(entry.handLabel)}</span>
      <span class="card-score">${entry.score}点カード</span>
    `;
    els.revealCards.appendChild(card);
  }
}

function renderHand(game) {
  const isMyTurn = game.phase === "playing" && game.currentPlayerId === game.viewerId;
  els.handTitle.textContent = isMyTurn ? "あなたの手札：選択してください" : "あなたの手札";

  els.handCards.innerHTML = "";
  const sortedHand = [...game.myHand].sort((a, b) => {
    const colorOrder = { white: 0, blue: 1, red: 2 };
    const handOrder = { rock: 0, scissors: 1, paper: 2 };
    return colorOrder[a.color] - colorOrder[b.color] || handOrder[a.hand] - handOrder[b.hand];
  });

  for (const card of sortedHand) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card-button color-${card.color}`;
    button.disabled = !isMyTurn;
    button.innerHTML = `
      <span>${COLOR_LABELS[card.color]}</span>
      <span class="card-hand">${HAND_LABELS[card.hand]}</span>
      <span class="card-score">${COLOR_SCORE[card.color]}点</span>
    `;
    button.addEventListener("click", () => {
      socket.emit("play-card", { cardId: card.id });
    });
    els.handCards.appendChild(button);
  }
}

function getPlayer(game, playerId) {
  return game.players.find((player) => player.id === playerId);
}

function namesByOrder(game, order) {
  return order.map((playerId) => getPlayer(game, playerId)?.name ?? "不明");
}

function getWinnerNames(rankings) {
  if (!rankings.length) return "なし";
  const topScore = rankings[0].score;
  return rankings
    .filter((player) => player.score === topScore)
    .map((player) => `${player.name}（${player.score}点）`)
    .join("、");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
