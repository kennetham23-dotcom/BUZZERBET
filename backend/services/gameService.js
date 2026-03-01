const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const logger = require('../config/logger');

// In-memory matchmaking queue: { socketId, userId, username, stake, premium_plan, joinedAt, resolve, reject, timeout }
const queue = [];
const MATCHMAKING_TIMEOUT = parseInt(process.env.MATCHMAKING_TIMEOUT_MS) || 30000;
const GAME_DURATION = parseInt(process.env.GAME_DURATION_SECONDS) || 60;

// Active games: gameId → { player1, player2, scores, startTime, timerRef, multTimers }
const activeGames = new Map();

function findMatch(newPlayer) {
  // Find first player in queue with same stake
  const idx = queue.findIndex(p => p.stake === newPlayer.stake && p.userId !== newPlayer.userId);
  if (idx !== -1) {
    const opponent = queue.splice(idx, 1)[0];
    return opponent;
  }
  return null;
}

function enqueue(player) {
  queue.push(player);
}

function dequeue(socketId) {
  const idx = queue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

async function createGame(player1, player2, stake, io) {
  const gameId = uuidv4();

  // Deduct stakes from both players (already deducted client-side at stake confirm; verify server-side)
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const player of [player1, player2]) {
      const [rows] = await conn.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [player.userId]);
      if (!rows.length || parseFloat(rows[0].balance) < stake) {
        await conn.rollback();
        throw new Error(`Insufficient balance for user ${player.userId}`);
      }
      await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [stake, player.userId]);

      const [[u]] = await conn.query('SELECT balance FROM users WHERE id = ?', [player.userId]);
      await conn.query(
        `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, game_id)
         VALUES (?, ?, 'stake', ?, ?, ?, 'completed', 'internal', ?)`,
        [uuidv4(), player.userId, stake, rows[0].balance, u.balance, gameId]
      );
    }

    await conn.query(
      `INSERT INTO games (id, player1_id, player2_id, stake_amount, status, started_at) VALUES (?, ?, ?, ?, 'playing', NOW())`,
      [gameId, player1.userId, player2.userId, stake]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
  conn.release();

  const game = {
    gameId,
    player1: { ...player1, score: 0, mult: 1, multUsed: false },
    player2: { ...player2, score: 0, mult: 1, multUsed: false },
    stake,
    startTime: Date.now(),
    timerRef: null,
    multTimers: {},
  };

  activeGames.set(gameId, game);

  // Notify both players
  io.to(player1.socketId).emit('game:start', {
    gameId, opponentName: player2.username, stake, duration: GAME_DURATION,
  });
  io.to(player2.socketId).emit('game:start', {
    gameId, opponentName: player1.username, stake, duration: GAME_DURATION,
  });

  logger.info(`Game started: ${gameId} | ${player1.username} vs ${player2.username} | stake GH₵${stake}`);

  // Auto-end after GAME_DURATION seconds
  game.timerRef = setTimeout(() => endGame(gameId, io), GAME_DURATION * 1000);

  return gameId;
}

async function handleTap(gameId, socketId, mult, io) {
  const game = activeGames.get(gameId);
  if (!game) return;

  const elapsed = (Date.now() - game.startTime) / 1000;
  if (elapsed >= GAME_DURATION) return;

  const isP1 = game.player1.socketId === socketId;
  const player = isP1 ? game.player1 : game.player2;
  const opponent = isP1 ? game.player2 : game.player1;

  const effectiveMult = player.mult || 1;
  player.score += effectiveMult;

  // Notify opponent of updated score
  io.to(opponent.socketId).emit('game:opp_score', { score: player.score });
  // Confirm to tapper
  io.to(player.socketId).emit('game:score_update', { score: player.score, mult: effectiveMult });
}

async function activateMultiplier(gameId, socketId, multValue, io) {
  const game = activeGames.get(gameId);
  if (!game) return;

  const isP1 = game.player1.socketId === socketId;
  const player = isP1 ? game.player1 : game.player2;

  if (player.multUsed) {
    io.to(socketId).emit('game:error', { message: 'Multiplier already used this round' });
    return;
  }

  player.mult = multValue;
  player.multUsed = true;

  io.to(socketId).emit('game:mult_activated', { mult: multValue });

  // Reset after 30s
  game.multTimers[socketId] = setTimeout(() => {
    player.mult = 1;
    io.to(socketId).emit('game:mult_expired');
  }, 30000);
}

async function endGame(gameId, io) {
  const game = activeGames.get(gameId);
  if (!game) return;

  activeGames.delete(gameId);
  clearTimeout(game.timerRef);
  Object.values(game.multTimers).forEach(clearTimeout);

  const { player1, player2, stake } = game;
  let winnerId = null;
  let winnerSocketId = null;
  let loserSocketId = null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (player1.score > player2.score) {
      winnerId = player1.userId;
      winnerSocketId = player1.socketId;
      loserSocketId = player2.socketId;
    } else if (player2.score > player1.score) {
      winnerId = player2.userId;
      winnerSocketId = player2.socketId;
      loserSocketId = player1.socketId;
    }

    // Update game record
    await conn.query(
      'UPDATE games SET status = ?, winner_id = ?, player1_score = ?, player2_score = ?, finished_at = NOW() WHERE id = ?',
      ['finished', winnerId, player1.score, player2.score, gameId]
    );

    if (winnerId) {
      // Winner gets double stake
      const winnings = stake * 2;
      const [[w]] = await conn.query('SELECT balance FROM users WHERE id = ?', [winnerId]);
      await conn.query('UPDATE users SET balance = balance + ?, total_wins = total_wins + 1, total_games = total_games + 1 WHERE id = ?',
        [winnings, winnerId]);
      const [[wAfter]] = await conn.query('SELECT balance FROM users WHERE id = ?', [winnerId]);
      await conn.query(
        `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, game_id)
         VALUES (?, ?, 'winnings', ?, ?, ?, 'completed', 'internal', ?)`,
        [uuidv4(), winnerId, winnings, w.balance, wAfter.balance, gameId]
      );

      // Update loser stats
      const loserId = winnerId === player1.userId ? player2.userId : player1.userId;
      await conn.query('UPDATE users SET total_losses = total_losses + 1, total_games = total_games + 1 WHERE id = ?', [loserId]);
    } else {
      // Tie — refund both
      for (const p of [player1, player2]) {
        const [[u]] = await conn.query('SELECT balance FROM users WHERE id = ?', [p.userId]);
        await conn.query('UPDATE users SET balance = balance + ?, total_games = total_games + 1 WHERE id = ?', [stake, p.userId]);
        const [[uAfter]] = await conn.query('SELECT balance FROM users WHERE id = ?', [p.userId]);
        await conn.query(
          `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, game_id)
           VALUES (?, ?, 'refund', ?, ?, ?, 'completed', 'internal', ?)`,
          [uuidv4(), p.userId, stake, u.balance, uAfter.balance, gameId]
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    logger.error('Error ending game', { gameId, err: err.message });
  } finally {
    conn.release();
  }

  // Fetch updated balances to send to clients
  const [[p1User]] = await pool.query('SELECT balance FROM users WHERE id = ?', [player1.userId]);
  const [[p2User]] = await pool.query('SELECT balance FROM users WHERE id = ?', [player2.userId]);

  const result = {
    gameId,
    yourScore: player1.score,
    oppScore: player2.score,
    stake,
    tied: !winnerId,
  };

  io.to(player1.socketId).emit('game:over', {
    ...result, won: winnerId === player1.userId, newBalance: parseFloat(p1User.balance),
  });
  io.to(player2.socketId).emit('game:over', {
    ...result,
    yourScore: player2.score,
    oppScore: player1.score,
    won: winnerId === player2.userId,
    newBalance: parseFloat(p2User.balance),
  });

  logger.info(`Game ended: ${gameId} | P1:${player1.score} vs P2:${player2.score} | winner=${winnerId || 'TIE'}`);
}

module.exports = {
  queue, activeGames, enqueue, dequeue, findMatch, createGame, handleTap, activateMultiplier, endGame,
};
