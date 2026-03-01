const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const { pool } = require('../config/db');
const logger = require('../config/logger');

const registerSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(/^(\+233|0)[0-9]{9}$/).required().messages({
    'string.pattern.base': 'Phone must be a valid Ghana number (e.g. 0241234567)',
  }),
  password: Joi.string().min(8).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

async function register(req, res, next) {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { username, email, phone, password } = value;

    // Check uniqueness
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ? OR username = ?', [email, username]
    );
    if (existing.length) return res.status(409).json({ error: 'Email or username already taken' });

    const password_hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'INSERT INTO users (username, email, phone, password_hash) VALUES (?, ?, ?, ?)',
      [username, email, phone, password_hash]
    );

    const token = signToken(result.insertId);
    logger.info(`User registered: ${username} (${email})`);

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: result.insertId, username, email, phone, balance: 0, premium_plan: 'none' },
    });
  } catch (err) { next(err); }
}

async function login(req, res, next) {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { email, password } = value;
    const [rows] = await pool.query(
      'SELECT id, username, email, phone, password_hash, balance, premium_plan, is_banned FROM users WHERE email = ?',
      [email]
    );

    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Account banned' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user.id);
    logger.info(`User logged in: ${user.username}`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        balance: parseFloat(user.balance),
        premium_plan: user.premium_plan,
      },
    });
  } catch (err) { next(err); }
}

async function getProfile(req, res) {
  const u = req.user;
  const [stats] = await pool.query(
    'SELECT total_wins, total_losses, total_games FROM users WHERE id = ?', [u.id]
  );
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    balance: parseFloat(u.balance),
    premium_plan: u.premium_plan,
    premium_expires_at: u.premium_expires_at,
    ...stats[0],
  });
}

module.exports = { register, login, getProfile };
