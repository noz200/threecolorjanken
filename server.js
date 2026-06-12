import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 3;
const MAX_ROUNDS = 9;
const LOBBY_STALE_MS = 30_000;
const HIDDEN_LOBBY_MS = 18_000;
const CLEANUP_INTERVAL_MS = 5_000;
const REVEAL_MS = 4_500;

const HANDS = {
  rock: "グー",
  scissors: "チョキ",
  paper: "パー",
};

const COLORS = {
  white: { label: "白", score: 1 },
  blue: { label: "青", score: 2 },
  red: { label: "赤", score: 3 },
};

const BEATS = {
  rock: "scissors",
  scissors: "paper",
  paper: "rock",
};

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  pingInterval: 5_000,
  pingTimeout: 10_000,
  cors: {
    origin: true,
    credentials: true,
  },
});

app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const waitingPlayers = new Map();
const games = new Map();
const playerToGame = new Map();

function now() {
  return Date.now();
}

function sanitizeName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!value) return "名無し";
  return value.slice(0, 16);
}

function createDeck() {
  const deck = [];
  for (const color of Object.keys(COLORS)) {
    for (const hand of Object.keys(HANDS)) {
      deck.push({
        id: `${color}-${hand}`,
        color,
        hand,
      });
    }
  }
  return deck;
}

function publicWaitingState() {
  const players = [...waitingPlayers.values()]
    .filter((player) => isEligibleWaitingPlayer(player))
    .map((player) => ({
      id: player.socketId,
      name: player.name,
      waitingMs: Math.max(0, now() - player.joinedAt),
    }));

  return {
    required: MAX_PLAYERS,
    count: players.length,
    players,
  };
}

function emitLobbyState() {
  io.emit("lobby-state", publicWaitingState());
}

function isEligibleWaitingPlayer(player) {
  const socket = io.sockets.sockets.get(player.socketId);
  if (!socket?.connected) return false;
  const age = now() - player.lastSeenAt;
  if (age > LOBBY_STALE_MS) return false;
  if (!player.visible && player.hiddenAt && now() - player.hiddenAt > HIDDEN_LOBBY_MS) return false;
  return true;
}

function removeFromWaiting(socketId, reason = "removed") {
  const player = waitingPlayers.get(socketId);
  if (!player) return;

  waitingPlayers.delete(socketId);
  const socket = io.sockets.sockets.get(socketId);
  socket?.emit("queue-removed", { reason });
}

function pruneWaitingPlayers() {
  let changed = false;

  for (const player of waitingPlayers.values()) {
    if (!isEligibleWaitingPlayer(player)) {
      waitingPlayers.delete(player.socketId);
      const socket = io.sockets.sockets.get(player.socketId);
      socket?.emit("queue-removed", {
        reason: player.visible === false ? "inactive" : "stale",
      });
      changed = true;
    }
  }

  if (changed) emitLobbyState();
}

function tryCreateMatch() {
  pruneWaitingPlayers();

  const candidates = [...waitingPlayers.values()]
    .filter((player) => isEligibleWaitingPlayer(player))
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(0, MAX_PLAYERS);

  if (candidates.length < MAX_PLAYERS) {
    emitLobbyState();
    return;
  }

  for (const player of candidates) {
    waitingPlayers.delete(player.socketId);
  }

  const game = createGame(candidates);
  games.set(game.id, game);

  for (const player of game.players) {
    playerToGame.set(player.id, game.id);
    const socket = io.sockets.sockets.get(player.id);
    socket?.join(game.id);
    socket?.emit("matched", {
      gameId: game.id,
      playerId: player.id,
      name: player.name,
    });
  }

  emitGameState(game);
  emitLobbyState();
}

function createGame(players) {
  const order = players.map((player) => player.socketId);

  return {
    id: randomUUID(),
    status: "playing",
    phase: "playing",
    round: 1,
    order,
    turnIndex: 0,
    players: players.map((player) => ({
      id: player.socketId,
      name: player.name,
      score: 0,
      deck: createDeck(),
      connected: true,
    })),
    submissions: [],
    reveal: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function findPlayer(game, playerId) {
  return game.players.find((player) => player.id === playerId);
}

function currentPlayerId(game) {
  return game.order[game.turnIndex];
}

function emitGameState(game) {
  for (const player of game.players) {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) continue;
    socket.emit("game-state", serializeGameForPlayer(game, player.id));
  }
}

function serializeGameForPlayer(game, viewerId) {
  const viewer = findPlayer(game, viewerId);

  return {
    id: game.id,
    status: game.status,
    phase: game.phase,
    round: game.round,
    maxRounds: MAX_ROUNDS,
    order: game.order,
    currentPlayerId: game.phase === "playing" ? currentPlayerId(game) : null,
    viewerId,
    players: game.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      cardCount: player.deck.length,
      connected: player.connected,
    })),
    submissions: game.submissions.map((submission) => ({
      playerId: submission.playerId,
      color: submission.card.color,
      colorLabel: COLORS[submission.card.color].label,
      revealed: game.phase !== "playing",
      hand: game.phase !== "playing" ? submission.card.hand : null,
      handLabel: game.phase !== "playing" ? HANDS[submission.card.hand] : null,
      score: COLORS[submission.card.color].score,
    })),
    myHand: viewer?.deck ?? [],
    reveal: game.reveal,
  };
}

function playCard(socket, cardId) {
  const gameId = playerToGame.get(socket.id);
  if (!gameId) {
    socket.emit("error-message", "参加中のゲームがありません。");
    return;
  }

  const game = games.get(gameId);
  if (!game || game.status !== "playing" || game.phase !== "playing") {
    socket.emit("error-message", "今はカードを出せません。");
    return;
  }

  if (currentPlayerId(game) !== socket.id) {
    socket.emit("error-message", "今はあなたの番ではありません。");
    return;
  }

  const player = findPlayer(game, socket.id);
  if (!player) {
    socket.emit("error-message", "プレイヤー情報が見つかりません。");
    return;
  }

  const index = player.deck.findIndex((card) => card.id === cardId);
  if (index < 0) {
    socket.emit("error-message", "そのカードはもう使えません。");
    return;
  }

  const [card] = player.deck.splice(index, 1);
  game.submissions.push({
    playerId: socket.id,
    card,
    previousOrderIndex: game.turnIndex,
  });

  game.updatedAt = now();
  game.turnIndex += 1;

  if (game.submissions.length >= MAX_PLAYERS) {
    finishRound(game);
  } else {
    emitGameState(game);
  }
}

function finishRound(game) {
  const result = resolveRound(game.submissions);
  const revealEntries = game.submissions.map((submission) => ({
    playerId: submission.playerId,
    name: findPlayer(game, submission.playerId)?.name ?? "不明",
    color: submission.card.color,
    colorLabel: COLORS[submission.card.color].label,
    hand: submission.card.hand,
    handLabel: HANDS[submission.card.hand],
    score: COLORS[submission.card.color].score,
  }));

  for (const winner of result.winners) {
    const player = findPlayer(game, winner.playerId);
    if (player) player.score += winner.gainedScore;
  }

  const nextOrder = updateOrder(game.order, result);

  game.phase = game.round >= MAX_ROUNDS ? "ended" : "reveal";
  game.status = game.round >= MAX_ROUNDS ? "ended" : "playing";
  game.reveal = {
    round: game.round,
    entries: revealEntries,
    isDraw: result.isDraw,
    winners: result.winners.map((winner) => ({
      playerId: winner.playerId,
      name: findPlayer(game, winner.playerId)?.name ?? "不明",
      gainedScore: winner.gainedScore,
    })),
    nextOrder,
    message: createRoundMessage(result, game),
    rankings: createRankings(game),
  };

  game.updatedAt = now();
  emitGameState(game);

  if (game.status === "ended") {
    cleanupGameLater(game.id);
    return;
  }

  setTimeout(() => {
    const current = games.get(game.id);
    if (!current || current.status !== "playing" || current.phase !== "reveal") return;

    current.round += 1;
    current.order = nextOrder;
    current.turnIndex = 0;
    current.submissions = [];
    current.reveal = null;
    current.phase = "playing";
    current.updatedAt = now();
    emitGameState(current);
  }, REVEAL_MS);
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
        gainedScore: COLORS[submission.card.color].score,
        previousOrderIndex: submission.previousOrderIndex,
      })),
  };
}

function updateOrder(previousOrder, result) {
  if (result.isDraw) return [...previousOrder];

  const previousIndex = Object.fromEntries(
    previousOrder.map((playerId, index) => [playerId, index]),
  );

  const winnerIds = new Set(result.winners.map((winner) => winner.playerId));
  const sortedWinners = [...result.winners]
    .sort((a, b) => {
      if (b.gainedScore !== a.gainedScore) return b.gainedScore - a.gainedScore;
      return previousIndex[a.playerId] - previousIndex[b.playerId];
    })
    .map((winner) => winner.playerId);

  const losers = previousOrder.filter((playerId) => !winnerIds.has(playerId));
  return [...sortedWinners, ...losers];
}

function createRoundMessage(result, game) {
  if (result.isDraw) {
    return "あいこ。点数なし、順番はそのまま。";
  }

  return result.winners
    .map((winner) => {
      const player = findPlayer(game, winner.playerId);
      return `${player?.name ?? "不明"} が ${winner.gainedScore}点獲得`;
    })
    .join(" / ");
}

function createRankings(game) {
  return game.players
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      score: player.score,
    }))
    .sort((a, b) => b.score - a.score);
}

function abortGameForDisconnect(socketId) {
  const gameId = playerToGame.get(socketId);
  if (!gameId) return;

  const game = games.get(gameId);
  if (!game || game.status === "ended" || game.status === "aborted") return;

  const player = findPlayer(game, socketId);
  if (player) player.connected = false;

  game.status = "aborted";
  game.phase = "aborted";
  game.reveal = {
    message: `${player?.name ?? "参加者"} が切断したため、ゲームを終了しました。`,
    rankings: createRankings(game),
  };

  emitGameState(game);
  cleanupGameLater(game.id);
}

function cleanupGameLater(gameId) {
  setTimeout(() => {
    const game = games.get(gameId);
    if (!game) return;

    for (const player of game.players) {
      playerToGame.delete(player.id);
      const socket = io.sockets.sockets.get(player.id);
      socket?.leave(gameId);
    }

    games.delete(gameId);
  }, 60_000);
}

io.on("connection", (socket) => {
  socket.emit("lobby-state", publicWaitingState());

  socket.on("join-queue", ({ name } = {}) => {
    abortGameForDisconnect(socket.id);
    waitingPlayers.delete(socket.id);

    const cleanName = sanitizeName(name);
    const timestamp = now();

    waitingPlayers.set(socket.id, {
      socketId: socket.id,
      name: cleanName,
      joinedAt: timestamp,
      lastSeenAt: timestamp,
      visible: true,
      hiddenAt: null,
    });

    socket.emit("waiting", {
      name: cleanName,
      message: "待機中です。3人そろうと自動で始まります。",
    });

    tryCreateMatch();
  });

  socket.on("leave-queue", () => {
    removeFromWaiting(socket.id, "left");
    emitLobbyState();
  });

  socket.on("play-card", ({ cardId } = {}) => {
    playCard(socket, cardId);
  });

  socket.on("heartbeat", ({ visible } = {}) => {
    const player = waitingPlayers.get(socket.id);
    if (!player) return;

    player.lastSeenAt = now();

    const isVisible = visible !== false;
    if (isVisible) {
      player.visible = true;
      player.hiddenAt = null;
    } else if (player.visible) {
      player.visible = false;
      player.hiddenAt = now();
    }
  });

  socket.on("return-lobby", () => {
    const gameId = playerToGame.get(socket.id);
    if (gameId) {
      const game = games.get(gameId);
      if (game && (game.status === "ended" || game.status === "aborted")) {
        playerToGame.delete(socket.id);
        socket.leave(gameId);
      }
    }
    socket.emit("lobby-state", publicWaitingState());
  });

  socket.on("disconnect", () => {
    const wasWaiting = waitingPlayers.delete(socket.id);
    if (wasWaiting) emitLobbyState();
    abortGameForDisconnect(socket.id);
  });
});

setInterval(() => {
  pruneWaitingPlayers();
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`threecolorjanken listening on http://localhost:${PORT}`);
});
