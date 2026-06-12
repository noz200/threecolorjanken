(() => {
  const supabaseGlobal = window.supabase;
  if (!supabaseGlobal?.createClient || supabaseGlobal.__tcjVisibilityGuardInstalled) return;

  const originalCreateClient = supabaseGlobal.createClient.bind(supabaseGlobal);

  supabaseGlobal.createClient = (...args) => {
    const client = originalCreateClient(...args);
    const originalFrom = client.from.bind(client);

    client.from = (tableName) => {
      const builder = originalFrom(tableName);
      if (tableName !== "tcj_games" || typeof builder.update !== "function") {
        return builder;
      }

      const originalUpdate = builder.update.bind(builder);
      builder.update = (values, options) => {
        return originalUpdate(transformGameUpdate(values), options);
      };

      return builder;
    };

    return client;
  };

  supabaseGlobal.__tcjVisibilityGuardInstalled = true;

  function transformGameUpdate(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return values;
    if (!Array.isArray(values.players) || !Array.isArray(values.submissions)) return values;

    const next = { ...values };
    const isIntermediateCardPlay = Object.prototype.hasOwnProperty.call(next, "turn_index")
      && !Object.prototype.hasOwnProperty.call(next, "phase");
    const isRoundCommit = next.phase === "reveal" || next.phase === "ended";

    if (isIntermediateCardPlay) {
      delete next.players;
      return next;
    }

    if (isRoundCommit) {
      next.players = removeSubmittedCards(next.players, next.submissions);
    }

    return next;
  }

  function removeSubmittedCards(players, submissions) {
    const submittedByPlayer = new Map();

    for (const submission of submissions) {
      const playerId = submission?.playerId;
      const cardId = submission?.card?.id;
      if (!playerId || !cardId) continue;

      if (!submittedByPlayer.has(playerId)) {
        submittedByPlayer.set(playerId, new Set());
      }
      submittedByPlayer.get(playerId).add(cardId);
    }

    return players.map((player) => {
      const usedCardIds = submittedByPlayer.get(player.id);
      if (!usedCardIds) return player;

      return {
        ...player,
        deck: (player.deck ?? []).filter((card) => !usedCardIds.has(card.id)),
      };
    });
  }
})();
