/**
 * BuzzerBet Admin API Routes
 * Mount at: /api/admin
 *
 * All routes require:
 *   - Valid JWT (authenticate middleware)
 *   - Admin role (requireAdmin middleware)
 *
 * To make a user admin, set `is_admin = 1` in the users table.
 * Run migration:
 *   ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { activeGames, queue } = require('../services/gameService');
const logger = require('../config/logger');

// ── ADMIN GUARD ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

router.use(authenticate, requireAdmin);

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/stats  — dashboard overview numbers
// ═══════════════════════════════════════════════════════════════════
router.get('/stats', async (req, res, next) => {
  try {
    const [[userStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total_users,
        SUM(is_banned = 0 AND is_active = 1) AS active_users,
        SUM(is_banned = 1) AS banned_users,
        SUM(premium_plan != 'none') AS premium_users,
        SUM(balance) AS total_balance_held
      FROM users
    `);

    const [[gameStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total_games,
        SUM(status = 'finished') AS finished_games,
        SUM(status = 'playing') AS live_games,
        SUM(stake_amount) AS total_staked,
        AVG(stake_amount) AS avg_stake
      FROM games
    `);

    const [[txStats]] = await pool.query(`
      SELECT
        SUM(type = 'deposit' AND status = 'completed') AS total_deposits,
        SUM(type = 'withdrawal' AND status = 'completed') AS total_withdrawals,
        SUM(CASE WHEN type = 'deposit' AND status = 'completed' THEN amount ELSE 0 END) AS deposit_volume,
        SUM(CASE WHEN type = 'withdrawal' AND status = 'completed' THEN amount ELSE 0 END) AS withdrawal_volume,
        SUM(type = 'premium' AND status = 'completed') AS premium_purchases
      FROM transactions
    `);

    // Revenue = 10% house edge (winner gets 2x stake, house keeps 0)
    // Platform revenue = sum of (stake * 2 - winnings) per game = 0 for P2P
    // Approx revenue from premium subs
    const [[premRevenue]] = await pool.query(`
      SELECT SUM(amount) AS premium_revenue
      FROM transactions
      WHERE type = 'premium' AND status = 'completed'
    `);

    // Live socket info
    const liveGamesList = Array.from(activeGames.values()).map(g => ({
      gameId: g.gameId,
      player1: g.player1.username,
      player2: g.player2.username,
      stake: g.stake,
      score1: g.player1.score,
      score2: g.player2.score,
      elapsed: Math.round((Date.now() - g.startTime) / 1000),
    }));

    res.json({
      users: userStats,
      games: gameStats,
      transactions: txStats,
      premium_revenue: premRevenue.premium_revenue || 0,
      live_games: liveGamesList,
      matchmaking_queue: queue.length,
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/revenue?period=7d|30d|90d  — chart data
// ═══════════════════════════════════════════════════════════════════
router.get('/revenue', async (req, res, next) => {
  try {
    const days = req.query.period === '30d' ? 30 : req.query.period === '90d' ? 90 : 7;

    const [revenueRows] = await pool.query(`
      SELECT
        DATE(created_at) AS day,
        SUM(CASE WHEN type='deposit' AND status='completed' THEN amount ELSE 0 END) AS deposits,
        SUM(CASE WHEN type='withdrawal' AND status='completed' THEN amount ELSE 0 END) AS withdrawals,
        SUM(CASE WHEN type='premium' AND status='completed' THEN amount ELSE 0 END) AS premium
      FROM transactions
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `, [days]);

    const [gameRows] = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM games
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `, [days]);

    const [userRows] = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM users
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `, [days]);

    // Provider breakdown
    const [providerRows] = await pool.query(`
      SELECT provider, SUM(amount) AS total
      FROM transactions
      WHERE type = 'deposit' AND status = 'completed'
      GROUP BY provider
    `);

    res.json({ revenue: revenueRows, games: gameRows, users: userRows, providers: providerRows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/users?page=1&limit=20&q=search&status=active|banned
// ═══════════════════════════════════════════════════════════════════
router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const q = req.query.q || '';
    const status = req.query.status || '';

    let where = 'WHERE 1=1';
    const params = [];

    if (q) {
      where += ' AND (username LIKE ? OR email LIKE ? OR phone LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status === 'banned') { where += ' AND is_banned = 1'; }
    else if (status === 'active') { where += ' AND is_banned = 0 AND is_active = 1'; }

    const [users] = await pool.query(
      `SELECT id, username, email, phone, balance, premium_plan, premium_expires_at,
        total_wins, total_losses, total_games, is_banned, is_active, is_admin, created_at
       FROM users ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM users ${where}`,
      params
    );

    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/users/:id  — single user detail
// ═══════════════════════════════════════════════════════════════════
router.get('/users/:id', async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, email, phone, balance, premium_plan, premium_expires_at,
        total_wins, total_losses, total_games, is_banned, is_active, is_admin, created_at
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Recent transactions
    const [txs] = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, status, provider, created_at
       FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );

    // Recent games
    const [games] = await pool.query(
      `SELECT g.id, g.stake_amount, g.player1_score, g.player2_score, g.winner_id,
        g.status, g.finished_at,
        u1.username AS player1_name, u2.username AS player2_name
       FROM games g
       JOIN users u1 ON u1.id = g.player1_id
       JOIN users u2 ON u2.id = g.player2_id
       WHERE g.player1_id = ? OR g.player2_id = ?
       ORDER BY g.created_at DESC LIMIT 10`,
      [user.id, user.id]
    );

    res.json({ user, transactions: txs, games });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/admin/users/:id  — update user (ban, adjust balance, etc)
// ═══════════════════════════════════════════════════════════════════
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { is_banned, is_active, balance_adjustment, note } = req.body;
    const userId = req.params.id;
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      if (typeof is_banned === 'boolean') {
        await conn.query('UPDATE users SET is_banned = ? WHERE id = ?', [is_banned, userId]);
        logger.info(`Admin ${req.user.username} ${is_banned ? 'banned' : 'unbanned'} user ${userId}`);
      }
      if (typeof is_active === 'boolean') {
        await conn.query('UPDATE users SET is_active = ? WHERE id = ?', [is_active, userId]);
      }
      if (balance_adjustment && !isNaN(parseFloat(balance_adjustment))) {
        const adj = parseFloat(balance_adjustment);
        const [[u]] = await conn.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]);
        const newBalance = Math.max(0, parseFloat(u.balance) + adj);
        await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
        const { v4: uuidv4 } = require('uuid');
        await conn.query(
          `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, metadata)
           VALUES (?, ?, 'deposit', ?, ?, ?, 'completed', 'internal', ?)`,
          [uuidv4(), userId, Math.abs(adj), u.balance, newBalance, 'internal',
           JSON.stringify({ admin: req.user.username, note: note || 'Admin balance adjustment' })]
        );
        logger.info(`Admin ${req.user.username} adjusted balance for user ${userId} by ${adj}`);
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [[updated]] = await pool.query('SELECT id, username, balance, is_banned, is_active FROM users WHERE id = ?', [userId]);
    res.json({ user: updated });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/transactions?page=1&type=&status=&user=
// ═══════════════════════════════════════════════════════════════════
router.get('/transactions', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (req.query.type) { where += ' AND t.type = ?'; params.push(req.query.type); }
    if (req.query.status) { where += ' AND t.status = ?'; params.push(req.query.status); }
    if (req.query.user) {
      where += ' AND (u.username LIKE ? OR u.email LIKE ?)';
      params.push(`%${req.query.user}%`, `%${req.query.user}%`);
    }

    const [txs] = await pool.query(
      `SELECT t.id, t.type, t.amount, t.status, t.provider, t.provider_ref,
        t.balance_before, t.balance_after, t.phone, t.created_at,
        u.username, u.email
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM transactions t JOIN users u ON u.id = t.user_id ${where}`,
      params
    );

    res.json({ transactions: txs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/games?page=1&status=
// ═══════════════════════════════════════════════════════════════════
router.get('/games', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    let where = '';
    const params = [];
    if (req.query.status) { where = 'WHERE g.status = ?'; params.push(req.query.status); }

    const [games] = await pool.query(
      `SELECT g.id, g.stake_amount, g.player1_score, g.player2_score,
        g.status, g.started_at, g.finished_at,
        u1.username AS player1_name, u2.username AS player2_name,
        uw.username AS winner_name
       FROM games g
       JOIN users u1 ON u1.id = g.player1_id
       JOIN users u2 ON u2.id = g.player2_id
       LEFT JOIN users uw ON uw.id = g.winner_id
       ${where}
       ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM games g ${where}`, params
    );

    res.json({ games, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/admin/games/:id/end  — force-end a live game
// ═══════════════════════════════════════════════════════════════════
router.post('/games/:id/end', async (req, res, next) => {
  try {
    const game = activeGames.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not active' });

    const { endGame } = require('../services/gameService');
    // We need io — get it from server module
    try {
      const { io } = require('../server');
      await endGame(req.params.id, io);
      logger.info(`Admin ${req.user.username} force-ended game ${req.params.id}`);
      res.json({ message: 'Game ended' });
    } catch {
      // Fallback: just mark as cancelled in DB
      await pool.query("UPDATE games SET status='cancelled', finished_at=NOW() WHERE id=?", [req.params.id]);
      activeGames.delete(req.params.id);
      res.json({ message: 'Game cancelled' });
    }
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/admin/premium  — subscription overview
// ═══════════════════════════════════════════════════════════════════
router.get('/premium', async (req, res, next) => {
  try {
    const [subs] = await pool.query(`
      SELECT id, username, email, premium_plan, premium_expires_at, created_at
      FROM users
      WHERE premium_plan != 'none'
      ORDER BY premium_expires_at DESC
    `);

    const [[counts]] = await pool.query(`
      SELECT
        SUM(premium_plan='silver') AS silver,
        SUM(premium_plan='bronze') AS bronze,
        SUM(premium_plan='gold') AS gold
      FROM users WHERE premium_plan != 'none'
    `);

    const [[revenue]] = await pool.query(`
      SELECT
        SUM(CASE WHEN metadata->'$.plan'='silver' OR amount=29 THEN amount ELSE 0 END) AS silver_rev,
        SUM(CASE WHEN metadata->'$.plan'='bronze' OR amount=49 THEN amount ELSE 0 END) AS bronze_rev,
        SUM(CASE WHEN metadata->'$.plan'='gold' OR amount=79 THEN amount ELSE 0 END) AS gold_rev,
        SUM(amount) AS total_rev
      FROM transactions WHERE type='premium' AND status='completed'
    `);

    res.json({ subscriptions: subs, counts, revenue });
  } catch (err) { next(err); }
});

module.exports = router;
