const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/db');

// GET /api/games/history
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const userId = req.user.id;

    const [rows] = await pool.query(
      `SELECT g.id, g.stake_amount,
        g.player1_score, g.player2_score, g.winner_id, g.status,
        g.started_at, g.finished_at,
        u1.username AS player1_name, u2.username AS player2_name,
        CASE
          WHEN g.player1_id = ? THEN g.player1_score
          ELSE g.player2_score
        END AS my_score,
        CASE
          WHEN g.player1_id = ? THEN g.player2_score
          ELSE g.player1_score
        END AS opp_score,
        CASE
          WHEN g.winner_id = ? THEN 'won'
          WHEN g.winner_id IS NULL THEN 'tied'
          ELSE 'lost'
        END AS result
       FROM games g
       JOIN users u1 ON u1.id = g.player1_id
       JOIN users u2 ON u2.id = g.player2_id
       WHERE g.player1_id = ? OR g.player2_id = ?
       ORDER BY g.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, userId, userId, userId, userId, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) as total FROM games WHERE player1_id = ? OR player2_id = ?',
      [userId, userId]
    );

    res.json({ games: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/games/leaderboard
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT username, total_wins, total_losses, total_games,
        ROUND(total_wins / GREATEST(total_games, 1) * 100, 1) AS win_rate
       FROM users WHERE total_games > 0
       ORDER BY total_wins DESC LIMIT 50`
    );
    res.json({ leaderboard: rows });
  } catch (err) { next(err); }
});

module.exports = router;
