const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      'SELECT id, username, email, phone, balance, premium_plan, premium_expires_at, is_active, is_banned FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    const user = rows[0];

    if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });
    if (user.is_banned) return res.status(403).json({ error: 'Account banned' });

    // Check if premium has expired
    if (user.premium_plan !== 'none' && user.premium_expires_at && new Date(user.premium_expires_at) < new Date()) {
      await pool.query("UPDATE users SET premium_plan = 'none', premium_expires_at = NULL WHERE id = ?", [user.id]);
      user.premium_plan = 'none';
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    next(err);
  }
}

module.exports = { authenticate };
