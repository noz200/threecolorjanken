const MAX_PLAYERS = 3;
const MAX_ROUNDS = 9;
const REVEAL_MS = 4500;
const LOBBY_STALE_MS = 30000;
const HIDDEN_LOBBY_MS = 18000;
const GAME_STALE_MS = 35000;
const HIDDEN_GAME_MS = 25000;

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

const BEATS = {
  rock: "scissors",
  scissors: "paper",
  paper: "rock",
};

const els = {
  joinView: document.getElementById("joinView"),
  waitingView: document.getElementById("waitingView"),
  gameView: document.getElementById("gameView"),
  setupWarning: document.getElementById("setupWarning"),
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

injectOpenHandsStyles();

const config = window.TCJ_SUPABASE_CONFIG ?? {};
const supabaseUrl = String(config.url ?? "").trim();
const supabaseKey = String(config.anonKey ?? "").trim();

const isConfigured = Boolean(
  supabaseUrl &&
  supabaseKey &&
  !supabaseUrl.includes("YOUR_PROJECT_ID") &&
  !supabaseUrl.includes("YOUR_PROJECT_REF") &&
  !supabaseKey.includes("YOUR_SUPABASE_ANON_KEY") &&
  !supabaseKey.includes("YOUR_SUPABASE_PUBLISHABLE_KEY"),
);

const playerId = getTabPlayerId();
let db = null;
let myName = localStorage.getItem("threecolorjanken.name") || "";
let isWaiting = false;
let currentGame = null;
let lobbyChannel = null;
let gameChannel = null;
let heartbeatTimer = null;
let maintenanceTimer = null;
let toastTimer = null;

els.nameInput.value = myName;

if (!isConfigured) {
  els.setupWarning.classList.remove("hidden");
  els.joinButton.disabled = true;
  toast("Supabase設定を入れるまで対戦できません。");
} else {
  db = window.supabase.createClient(supabaseUrl, supabaseKey);
  boot();
}

function boot() {
  subscribeLobby();
  subscribeGames();
  loadLobby();

  heartbeatTimer = setInterval(heartbeat, 4000);
  maintenanceTimer = setInterval(() => {
    if (isWaiting) tryMatch();
    if (currentGame) {
      maybeAdvanceReveal();
      checkGamePresence();
    }
  }, 3000);

  heartbeat();
}

function injectOpenHandsStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .open-hands {
      display: block;
    }

    .player-hand-block {
      width: 100%;
      margin: 0 0 12px;
      padding: 10px;
      background: rgba(0, 0, 0, .24);
      border: 2px solid rgba(255, 255, 255, .35);
      box-shadow: 0 4px 0 rgba(0,0,0,.18);
    }

    .player-hand-block.mine {
      border-color: rgba(255, 225, 91, .85);
    }

    .player-hand-block.current-turn {
      outline: 4px solid #ffe15b;
    }

    .player-hand-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 800;
    }

    .player-hand-sub {
      color: #e4e4e4;
      font-size: 12px;
      font-weight: 700;
    }

    .player-hand-cards {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .player-hand-cards .reveal-card {
      box-shadow: 0 5px 0 rgba(0,0,0,.25);
    }

    .card-button.playable {
      outline: 4px solid #fff6a5;
    }
  `;
  document.head.appendChild(style);
}

function getTabPlayerId() {
  const key = "threecolorjanken.playerId";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function show(view) {
  els.joinView.classList.toggle("hidden", view !== "join");
  els.waitingView.classList.toggle("hidden", view !== "waiting");
  els.gameView.classList.toggle("hidden", view !== "game");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2800);
}

function visibleNow() {
  return document.visibilityState === "visible";
}

function nowIso() {
  return new Date().toISOString();
}

function cutoffIso(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function sanitizeName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  return (value || "名無し").slice(0, 16);
}

els.joinButton.addEventListener("click", joinQueue);
els.nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinQueue();
});
els.leaveButton.addEventListener("click", leaveQueue);
els.backLobbyButton.addEventListener("click", returnLobby);
els.rematchButton.addEventListener("click", async () => {
  await returnLobby();
  await joinQueue();
});

document.addEventListener("visibilitychange", async () => {
  await heartbeat();

  if (isWaiting && !visibleNow()) {
    setTimeout(async () => {
      if (isWaiting && !visibleNow()) {
        await leaveQueue("待機中にタブが非表示のままだったため、待機から外しました。");
      }
    }, HIDDEN_LOBBY_MS);
  }
});

window.addEventListener("beforeunload", () => {
  if (!db) return;
  if (isWaiting) {
    db.from("tcj_waiting").delete().eq("player_id", playerId);
  }
  if (currentGame && currentGame.status === "playing") {
    abortGame("参加者のタブが閉じられたため、ゲームを終了しました。", false);
  }
});

async function subscribeLobby() {
  lobbyChannel = db
    .channel("tcj-waiting-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tcj_waiting" },
      async () => {
        await loadLobby();
        if (isWaiting) await tryMatch();
      },
    )
    .subscribe();
}

async function subscribeGames() {
  gameChannel = db
    .channel("tcj-game-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tcj_games" },
      (payload) => {
        if (!payload.new) return;
        if (isMyGame(payload.new)) {
          setGame(payload.new);
        }
      },
    )
    .subscribe();
}

async function joinQueue() {
  if (!db) return;

  myName = sanitizeName(els.nameInput.value);
  localStorage.setItem("threecolorjanken.name", myName);

  await cleanupMyWaitingRow();

  const row = {
    player_id: playerId,
    name: myName,
    visible: true,
    joined_at: nowIso(),
    updated_at: nowIso(),
  };

  const { error } = await db.from("tcj_waiting").upsert(row, { onConflict: "player_id" });
  if (error) {
    toast(`待機に失敗: ${error.message}`);
    return;
  }

  await upsertPresence({ mode: "waiting", gameId: null });

  isWaiting = true;
  currentGame = null;
  show("waiting");
  await loadLobby();
  await tryMatch();
}

async function leaveQueue(message) {
  if (!db) return;
  isWaiting = false;
  await cleanupMyWaitingRow();
  await db.from("tcj_presence").delete().eq("player_id", playerId);

  if (message) toast(message);
  show("join");
  await loadLobby();
}

async function cleanupMyWaitingRow() {
  await db.from("tcj_waiting").delete().eq("player_id", playerId);
}

async function tryMatch() {
  if (!db || !isWaiting || !visibleNow()) return;

  const { data, error } = await db.rpc("tcj_try_match", { p_player_id: playerId });
  if (error) {
    toast(`マッチング失敗: ${error.message}`);
    return;
  }

  if (data) {
    await loadGame(data);
    return;
  }

  await findMyActiveGame();
}

async function findMyActiveGame() {
  const { data, error } = await db
    .from("tcj_games")
    .select("*")
    .in("status", ["playing", "ended", "aborted"])
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) return;

  const game = (data ?? []).find(isMyGame);
  if (game) setGame(game);
}

async function loadGame(gameId) {
  const { data, error } = await db
    .from("tcj_games")
    .select("*")
    .eq("id", gameId)
    .single();

  if (error) {
    toast(`ゲーム取得失敗: ${error.message}`);
    return;
  }

  if (data) setGame(data);
}

function setGame(game) {
  currentGame = normalizeGame(game);
  isWaiting = false;
  show("game");
  upsertPresence({ mode: "game", gameId: currentGame.id });
  renderGame(currentGame);
}

function normalizeGame(game) {
  return {
    ...game,
    order_ids: game.order_ids ?? [],
    players: game.players ?? [],
    submissions: game.submissions ?? [],
  };
}

function isMyGame(game) {
  return Array.isArray(game?.players) && game.players.some((player) => player.id === playerId);
}

async function loadLobby() {
  if (!db) return;

  const { data, error } = await db
    .from("tcj_waiting")
    .select("player_id, name, joined_at, updated_at, visible")
    .eq("visible", true)
    .gte("updated_at", cutoffIso(LOBBY_STALE_MS))
    .order("joined_at", { ascending: true });

  if (error) {
    toast(`ロビー取得失敗: ${error.message}`);
    return;
  }

  renderLobby(data ?? []);
}

async function heartbeat() {
  if (!db) return;

  if (isWaiting) {
    await db
      .from("tcj_waiting")
      .update({
        visible: visibleNow(),
        updated_at: nowIso(),
      })
      .eq("player_id", playerId);

    await upsertPresence({ mode: "waiting", gameId: null });
  }

  if (currentGame && currentGame.status === "playing") {
    await upsertPresence({ mode: "game", gameId: currentGame.id });
  }
}

async function upsertPresence({ mode, gameId }) {
  if (!db) return;

  await db.from("tcj_presence").upsert(
    {
      player_id: playerId,
      name: myName || sanitizeName(els.nameInput.value),
      game_id: gameId,
      mode,
      visible: visibleNow(),
      updated_at: nowIso(),
    },
    { onConflict: "player_id" },
  );
}

async function checkGamePresence() {
  if (!currentGame || currentGame.status !== "playing") return;

  const { data, error } = await db
    .from("tcj_presence")
    .select("player_id, name, visible, updated_at")
    .eq("game_id", currentGame.id);

  if (error) return;

  const presenceById = new Map((data ?? []).map((row) => [row.player_id, row]));
  const stalePlayer = currentGame.players.find((player) => {
    const presence = presenceById.get(player.id);
    if (!presence) return true;

    const age = Date.now() - new Date(presence.updated_at).getTime();
    if (age > GAME_STALE_MS) return true;
    if (!presence.visible && age > HIDDEN_GAME_MS) return true;

    return false;
  });

  if (stalePlayer) {
    await abortGame(`${stalePlayer.name} の接続が切れたため、ゲームを終了しました。`, true);
  }
}

async function abortGame(message, reloadAfterUpdate) {
  if (!currentGame || currentGame.status !== "playing") return;

  const reveal = {
    message,
    rankings: createRankings(currentGame.players),
  };

  const { error } = await db
    .from("tcj_games")
    .update({
      status: "aborted",
      phase: "aborted",
      reveal,
      updated_at: nowIso(),
    })
    .eq("id", currentGame.id)
    .eq("status", "playing");

  if (!error && reloadAfterUpdate) {
    await loadGame(currentGame.id);
  }
}

async function playCard(cardId) {
  if (!currentGame || currentGame.status !== "playing" || currentGame.phase !== "playing") return;

  if (currentPlayerId(currentGame) !== playerId) {
    toast("今はあなたの番ではありません。");
    return;
  }

  const latest = await fetchCurrentGame();
  if (!latest || latest.status !== "playing" || latest.phase !== "playing") return;
  if (currentPlayerId(latest) !== playerId) {
    toast("少し遅れました。今はあなたの番ではありません。");
    return;
  }

  const players = structuredClone(latest.players);
  const me = players.find((player) => player.id === playerId);
  const cardIndex = me?.deck?.findIndex((card) => card.id === cardId) ?? -1;

  if (!me || cardIndex < 0) {
    toast("そのカードはもう使えません。");
    return;
  }

  const [card] = me.deck.splice(cardIndex, 1);
  const submissions = [
    ...(latest.submissions ?? []),
    {
      playerId,
      card,
      previousOrderIndex: latest.turn_index,
    },
  ];

  if (submissions.length >= MAX_PLAYERS) {
    await finishRound(latest, players, submissions);
    return;
  }

  const { error } = await db
    .from("tcj_games")
    .update({
      players,
      submissions,
      turn_index: latest.turn_index + 1,
      updated_at: nowIso(),
    })
    .eq("id", latest.id)
    .eq("phase", "playing");

  if (error) {
    toast(`カード送信失敗: ${error.message}`);
  }
}

async function fetchCurrentGame() {
  if (!currentGame) return null;

  const { data, error } = await db
    .from("tcj_games")
    .select("*")
    .eq("id", currentGame.id)
    .single();

  if (error) {
    toast(`ゲーム更新失敗: ${error.message}`);
    return null;
  }

  return normalizeGame(data);
}

async function finishRound(game, players, submissions) {
  const result = resolveRound(submissions);

  for (const winner of result.winners) {
    const player = players.find((item) => item.id === winner.playerId);
    if (player) player.score += winner.gainedScore;
  }

  const nextOrder = updateOrder(game.order_ids, result);
  const reveal = {
    round: game.round,
    entries: submissions.map((submission) => {
      const player = players.find((item) => item.id === submission.playerId);
      return {
        playerId: submission.playerId,
        name: player?.name ?? "不明",
        color: submission.card.color,
        colorLabel: COLOR_LABELS[submission.card.color],
        hand: submission.card.hand,
        handLabel: HAND_LABELS[submission.card.hand],
        score: COLOR_SCORE[submission.card.color],
      };
    }),
    isDraw: result.isDraw,
    winners: result.winners.map((winner) => {
      const player = players.find((item) => item.id === winner.playerId);
      return {
        playerId: winner.playerId,
        name: player?.name ?? "不明",
        gainedScore: winner.gainedScore,
      };
    }),
    nextOrder,
    message: createRoundMessage(result, players),
    rankings: createRankings(players),
  };

  const ended = game.round >= MAX_ROUNDS;

  const { error } = await db
    .from("tcj_games")
    .update({
      status: ended ? "ended" : "playing",
      phase: ended ? "ended" : "reveal",
      players,
      submissions,
      reveal,
      phase_ends_at: ended ? null : new Date(Date.now() + REVEAL_MS).toISOString(),
      updated_at: nowIso(),
    })
    .eq("id", game.id)
    .eq("phase", "playing");

  if (error) {
    toast(`ラウンド終了処理に失敗: ${error.message}`);
  }
}

async function maybeAdvanceReveal() {
  if (!currentGame || currentGame.status !== "playing" || currentGame.phase !== "reveal") return;
  if (!currentGame.phase_ends_at) return;
  if (Date.now() < new Date(currentGame.phase_ends_at).getTime()) return;

  const latest = await fetchCurrentGame();
  if (!latest || latest.phase !== "reveal" || latest.status !== "playing") return;
  if (Date.now() < new Date(latest.phase_ends_at).getTime()) return;

  const nextOrder = latest.reveal?.nextOrder ?? latest.order_ids;

  const { error } = await db
    .from("tcj_games")
    .update({
      phase: "playing",
      round: latest.round + 1,
      order_ids: nextOrder,
      turn_index: 0,
      submissions: [],
      reveal: null,
      phase_ends_at: null,
      updated_at: nowIso(),
    })
    .eq("id", latest.id)
    .eq("phase", "reveal");

  if (error) {
    toast(`次ラウンド開始失敗: ${error.message}`);
  }
}

function resolveRound(submissions) {
  const usedHands = [...new Set(submissions.map((submission) => submission.card.hand))];

  if (usedHands.length === 1 || usedHands.length === 3) {
    return {
      isDraw: true,
      winners: [],
    };
  }

  const [first, second] = usedHands;
  const winningHand = BEATS[first] === second ? first : second;

  return {
    isDraw: false,
    winners: submissions
      .filter((submission) => submission.card.hand === winningHand)
      .map((submission) => ({
        playerId: submission.playerId,
        gainedScore: COLOR_SCORE[submission.card.color],
        previousOrderIndex: submission.previousOrderIndex,
      })),
  };
}

function updateOrder(previousOrder, result) {
  if (result.isDraw) return [...previousOrder];

  const previousIndex = Object.fromEntries(
    previousOrder.map((id, index) => [id, index]),
  );

  const winnerIds = new Set(result.winners.map((winner) => winner.playerId));
  const sortedWinners = [...result.winners]
    .sort((a, b) => {
      if (b.gainedScore !== a.gainedScore) return b.gainedScore - a.gainedScore;
      return previousIndex[a.playerId] - previousIndex[b.playerId];
    })
    .map((winner) => winner.playerId);

  const losers = previousOrder.filter((id) => !winnerIds.has(id));
  return [...sortedWinners, ...losers];
}

function createRoundMessage(result, players) {
  if (result.isDraw) return "あいこ。点数なし、順番はそのまま。";

  return result.winners
    .map((winner) => {
      const player = players.find((item) => item.id === winner.playerId);
      return `${player?.name ?? "不明"} が ${winner.gainedScore}点獲得`;
    })
    .join(" / ");
}

function createRankings(players) {
  return players
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      score: player.score,
    }))
    .sort((a, b) => b.score - a.score);
}

function currentPlayerId(game) {
  if (game.phase !== "playing") return null;
  return game.order_ids?.[game.turn_index] ?? null;
}

function renderLobby(players) {
  const count = players.length;
  const percentage = Math.min(100, Math.round((count / MAX_PLAYERS) * 100));

  els.waitingBar.style.width = `${percentage}%`;
  els.waitingMessage.textContent = `${count} / ${MAX_PLAYERS} 人が待機中です。`;
  els.waitingPlayers.innerHTML = "";

  for (const player of players) {
    const li = document.createElement("li");
    li.textContent = player.name;
    els.waitingPlayers.appendChild(li);
  }
}

function renderGame(game) {
  els.connectionBadge.textContent = "ONLINE";

  if (game.status === "ended") {
    els.roundBadge.textContent = "GAME SET";
  } else if (game.status === "aborted") {
    els.roundBadge.textContent = "ABORTED";
  } else {
    els.roundBadge.textContent = `ROUND ${game.round} / ${MAX_ROUNDS}`;
  }

  renderScores(game);
  renderOrder(game);
  renderSubmissions(game);
  renderReveal(game);
  renderHand(game);

  const endedOrAborted = game.status === "ended" || game.status === "aborted";
  els.afterGame.classList.toggle("hidden", !endedOrAborted);

  if (game.status === "aborted") {
    els.mainMessage.textContent = game.reveal?.message ?? "切断によりゲームを終了しました。";
    return;
  }

  if (game.status === "ended") {
    const winners = getWinnerNames(game.reveal?.rankings ?? createRankings(game.players));
    els.mainMessage.textContent = `ゲーム終了。勝者: ${winners}`;
    return;
  }

  if (game.phase === "reveal") {
    els.mainMessage.textContent = `${game.reveal?.message ?? "公開中"}\n次の順番: ${namesByOrder(game, game.reveal?.nextOrder ?? game.order_ids).join(" → ")}`;
    return;
  }

  const current = getPlayer(game, currentPlayerId(game));

  if (currentPlayerId(game) === playerId) {
    els.mainMessage.textContent = "あなたの番です。全員の残り手札を見て、カードを1枚選んでください。";
  } else {
    els.mainMessage.textContent = `${current?.name ?? "相手"} の番です。全員の残り手札を見て待ちましょう。`;
  }
}

function renderScores(game) {
  els.scoreBoard.innerHTML = "";

  for (const player of game.players) {
    const div = document.createElement("div");
    div.className = "score-card";

    if (player.id === currentPlayerId(game) && game.phase === "playing") {
      div.classList.add("current");
    }

    div.innerHTML = `
      <div class="score-name">${escapeHtml(player.name)}</div>
      <div class="score-value">${player.score} 点</div>
      <div class="score-small">残り ${player.deck?.length ?? 0} 枚</div>
    `;

    els.scoreBoard.appendChild(div);
  }
}

function renderOrder(game) {
  els.orderList.innerHTML = "";

  for (const id of game.order_ids) {
    const player = getPlayer(game, id);
    const li = document.createElement("li");
    li.textContent = player?.name ?? "不明";

    if (id === currentPlayerId(game) && game.phase === "playing") {
      li.classList.add("active");
    }

    els.orderList.appendChild(li);
  }
}

function renderSubmissions(game) {
  els.submittedArea.innerHTML = "";

  for (const submission of game.submissions ?? []) {
    const player = getPlayer(game, submission.playerId);
    const div = document.createElement("div");
    div.className = "submitted-chip";

    const revealed = game.phase !== "playing";
    const color = submission.card.color;
    const cardText = revealed
      ? `${COLOR_LABELS[color]}${HAND_LABELS[submission.card.hand]}`
      : `${COLOR_LABELS[color]}？`;

    div.innerHTML = `
      <div>${escapeHtml(player?.name ?? "不明")}</div>
      <span class="color-chip color-${color}">${escapeHtml(cardText)}</span>
    `;

    els.submittedArea.appendChild(div);
  }
}

function renderReveal(game) {
  const showReveal = game.phase === "reveal" || game.phase === "ended";
  els.revealArea.classList.toggle("hidden", !showReveal);
  els.revealCards.innerHTML = "";

  for (const entry of game.reveal?.entries ?? []) {
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
  const activePlayerId = currentPlayerId(game);
  const isPlaying = game.status === "playing" && game.phase === "playing";

  els.handTitle.textContent = "全員の残り手札";
  els.handCards.classList.add("open-hands");
  els.handCards.innerHTML = "";

  for (const player of game.players) {
    const isMe = player.id === playerId;
    const isCurrentTurn = isPlaying && activePlayerId === player.id;
    const isMyTurn = isMe && isCurrentTurn;

    const block = document.createElement("section");
    block.className = "player-hand-block";
    if (isMe) block.classList.add("mine");
    if (isCurrentTurn) block.classList.add("current-turn");

    const hand = sortDeck(player.deck ?? []);
    const header = document.createElement("div");
    header.className = "player-hand-header";

    const title = document.createElement("span");
    title.textContent = `${player.name}${isMe ? "（あなた）" : ""}`;

    const sub = document.createElement("span");
    sub.className = "player-hand-sub";
    sub.textContent = `${isCurrentTurn ? "今の番 / " : ""}残り ${hand.length} 枚`;

    header.appendChild(title);
    header.appendChild(sub);
    block.appendChild(header);

    const cards = document.createElement("div");
    cards.className = "player-hand-cards";

    for (const card of hand) {
      const cardEl = isMyTurn ? document.createElement("button") : document.createElement("div");
      cardEl.className = `${isMyTurn ? "card-button playable" : "reveal-card"} color-${card.color}`;

      if (isMyTurn) {
        cardEl.type = "button";
        cardEl.addEventListener("click", () => playCard(card.id));
      }

      cardEl.innerHTML = `
        <span>${COLOR_LABELS[card.color]}</span>
        <span class="card-hand">${HAND_LABELS[card.hand]}</span>
        <span class="card-score">${COLOR_SCORE[card.color]}点</span>
      `;

      cards.appendChild(cardEl);
    }

    block.appendChild(cards);
    els.handCards.appendChild(block);
  }
}

function sortDeck(deck) {
  const colorOrder = { white: 0, blue: 1, red: 2 };
  const handOrder = { rock: 0, scissors: 1, paper: 2 };

  return [...deck].sort((a, b) => {
    return colorOrder[a.color] - colorOrder[b.color] || handOrder[a.hand] - handOrder[b.hand];
  });
}

function getPlayer(game, id) {
  return game.players.find((player) => player.id === id);
}

function namesByOrder(game, order) {
  return order.map((id) => getPlayer(game, id)?.name ?? "不明");
}

function getWinnerNames(rankings) {
  if (!rankings.length) return "なし";

  const topScore = rankings[0].score;
  return rankings
    .filter((player) => player.score === topScore)
    .map((player) => `${player.name}（${player.score}点）`)
    .join("、");
}

async function returnLobby() {
  currentGame = null;
  await db.from("tcj_presence").delete().eq("player_id", playerId);
  show("join");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
