const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const gameService = require('../services/gameService');
const logger = require('../config/logger');

const connectedUsers = new Map();

function initSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const [rows] = await pool.query(
        'SELECT id, username, email, balance, premium_plan, is_banned FROM users WHERE id = ?',
        [decoded.userId]
      );
      if (!rows.length) return next(new Error('User not found'));
      if (rows[0].is_banned) return next(new Error('Account banned'));
      socket.user = rows[0];
      next();
    } catch (err) { next(new Error('Invalid token')); }
  });

  io.on('connection', (socket) => {
    const { id: socketId, user } = socket;
    connectedUsers.set(socketId, user.id);
    logger.info(`Socket connected: ${user.username} (${socketId})`);

    // ── MATCHMAKING ──────────────────────────────────────────────────────────
    socket.on('matchmaking:join', async ({ stake }) => {
      try {
        const stakeAmount = parseFloat(stake);
        if (!stakeAmount || stakeAmount < 1) {
          return socket.emit('matchmaking:error', { message: 'Invalid stake amount (min GH₵1)' });
        }
        const [[freshUser]] = await pool.query('SELECT balance, premium_plan FROM users WHERE id = ?', [user.id]);
        if (parseFloat(freshUser.balance) < stakeAmount) {
          return socket.emit('matchmaking:error', { message: 'Insufficient balance' });
        }
        socket.emit('matchmaking:searching', { stake: stakeAmount });
        const newPlayer = {
          socketId, userId: user.id, username: user.username,
          stake: stakeAmount, premium_plan: freshUser.premium_plan, joinedAt: Date.now(),
        };
        const opponent = gameService.findMatch(newPlayer);
        if (opponent) {
          clearTimeout(opponent.timeout);
          try {
            await gameService.createGame(newPlayer, opponent, stakeAmount, io);
            socket.emit('matchmaking:found', { opponent: opponent.username });
            io.to(opponent.socketId).emit('matchmaking:found', { opponent: user.username });
          } catch (err) {
            socket.emit('matchmaking:error', { message: err.message });
            io.to(opponent.socketId).emit('matchmaking:error', { message: err.message });
          }
        } else {
          newPlayer.timeout = setTimeout(() => {
            gameService.dequeue(socketId);
            socket.emit('matchmaking:timeout', { message: 'No opponent found. Stake refunded.' });
          }, parseInt(process.env.MATCHMAKING_TIMEOUT_MS) || 30000);
          gameService.enqueue(newPlayer);
        }
      } catch (err) {
        logger.error('matchmaking:join error', { err: err.message });
        socket.emit('matchmaking:error', { message: 'Server error during matchmaking' });
      }
    });

    socket.on('matchmaking:cancel', () => {
      gameService.dequeue(socketId);
      socket.emit('matchmaking:cancelled');
    });

    // ── GAMEPLAY ─────────────────────────────────────────────────────────────
    socket.on('game:tap', ({ gameId }) => {
      const game = gameService.activeGames.get(gameId);
      if (!game) return socket.emit('game:error', { message: 'Game not found' });
      const isP1 = game.player1.socketId === socketId;
      const isP2 = game.player2.socketId === socketId;
      if (!isP1 && !isP2) return socket.emit('game:error', { message: 'Not your game' });
      gameService.handleTap(gameId, socketId, null, io);
    });

    // Batch taps from offline reconnect
    socket.on('game:tap_batch', ({ gameId, count }) => {
      if (!gameId || !count || count < 1) return;
      const game = gameService.activeGames.get(gameId);
      if (!game) return;
      const isP1 = game.player1.socketId === socketId;
      const isP2 = game.player2.socketId === socketId;
      if (!isP1 && !isP2) return;
      const batchCount = Math.min(count, 50); // cap at 50 to prevent abuse
      for (let i = 0; i < batchCount; i++) {
        gameService.handleTap(gameId, socketId, null, io);
      }
      logger.info(`Batch tap flush: ${batchCount} taps for game ${gameId}`);
    });

    socket.on('game:activate_mult', async ({ gameId, mult }) => {
      const game = gameService.activeGames.get(gameId);
      if (!game) return socket.emit('game:error', { message: 'Game not found' });
      const planMults = { none: 1, silver: 2, bronze: 3, gold: 4 };
      const [[freshUser]] = await pool.query('SELECT premium_plan FROM users WHERE id = ?', [user.id]);
      const maxMult = planMults[freshUser.premium_plan] || 1;
      if (mult > maxMult) {
        return socket.emit('game:error', { message: `Your plan only allows up to x${maxMult}` });
      }
      await gameService.activateMultiplier(gameId, socketId, mult, io);
    });

    // ── DISCONNECT ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      gameService.dequeue(socketId);
      connectedUsers.delete(socketId);
      logger.info(`Socket disconnected: ${user.username} (${socketId})`);
      for (const [gameId, game] of gameService.activeGames.entries()) {
        if (game.player1.socketId === socketId || game.player2.socketId === socketId) {
          const winner = game.player1.socketId === socketId ? game.player2 : game.player1;
          io.to(winner.socketId).emit('game:opponent_disconnected', {
            message: 'Opponent disconnected. You win by default!',
          });
          gameService.endGame(gameId, io);
          break;
        }
      }
    });
  });
}

module.exports = { initSocket };
