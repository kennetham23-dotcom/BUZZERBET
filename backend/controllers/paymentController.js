const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const { pool } = require('../config/db');
const { initiateDeposit, initiateWithdrawal, stripeVerifyWebhook } = require('../services/paymentService');
const logger = require('../config/logger');

const PROVIDERS = ['mtn', 'vodafone', 'airteltigo', 'stripe'];
const PREMIUM_PRICES = {
  silver: parseFloat(process.env.PREMIUM_SILVER_PRICE) || 29,
  bronze: parseFloat(process.env.PREMIUM_BRONZE_PRICE) || 49,
  gold:   parseFloat(process.env.PREMIUM_GOLD_PRICE)   || 79,
};

const depositSchema = Joi.object({
  amount: Joi.number().positive().min(1).max(10000).required(),
  provider: Joi.string().valid(...PROVIDERS).required(),
  phone: Joi.string().when('provider', {
    is: Joi.valid('mtn', 'vodafone', 'airteltigo'),
    then: Joi.string().pattern(/^(\+233|0)[0-9]{9}$/).required(),
    otherwise: Joi.string().optional(),
  }),
});

const withdrawSchema = Joi.object({
  amount: Joi.number().positive().min(1).required(),
  provider: Joi.string().valid('mtn', 'vodafone', 'airteltigo').required(),
  phone: Joi.string().pattern(/^(\+233|0)[0-9]{9}$/).required(),
});

// POST /api/payments/deposit
async function deposit(req, res, next) {
  try {
    const { error, value } = depositSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { amount, provider, phone } = value;
    const userId = req.user.id;
    const txId = uuidv4();

    // Record pending transaction
    await pool.query(
      `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, phone)
       VALUES (?, ?, 'deposit', ?, ?, ?, 'pending', ?, ?)`,
      [txId, userId, amount, req.user.balance, req.user.balance, provider, phone || null]
    );

    const result = await initiateDeposit({ provider, phone, amount, userId });

    // Update transaction with provider ref
    await pool.query(
      'UPDATE transactions SET provider_ref = ? WHERE id = ?',
      [result.referenceId || result.intentId, txId]
    );

    res.json({ transactionId: txId, ...result });
  } catch (err) { next(err); }
}

// POST /api/payments/withdraw
async function withdraw(req, res, next) {
  try {
    const { error, value } = withdrawSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { amount, provider, phone } = value;
    const userId = req.user.id;

    if (amount > req.user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const txId = uuidv4();
    const newBalance = parseFloat(req.user.balance) - amount;

    await pool.query('START TRANSACTION');
    try {
      await pool.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, userId, amount]);
      const [updated] = await pool.query('SELECT balance FROM users WHERE id = ?', [userId]);
      if (!updated.length) throw new Error('Balance update failed');

      await pool.query(
        `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider, phone)
         VALUES (?, ?, 'withdrawal', ?, ?, ?, 'pending', ?, ?)`,
        [txId, userId, amount, req.user.balance, newBalance, provider, phone]
      );

      const result = await initiateWithdrawal({ provider, phone, amount, userId });
      await pool.query('UPDATE transactions SET provider_ref = ?, status = ? WHERE id = ?',
        [result.referenceId, result.status, txId]);

      await pool.query('COMMIT');
      res.json({ transactionId: txId, newBalance, ...result });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) { next(err); }
}

// POST /api/payments/premium
async function subscribePremium(req, res, next) {
  try {
    const { plan } = req.body;
    if (!['silver', 'bronze', 'gold'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose silver, bronze, or gold.' });
    }

    const price = PREMIUM_PRICES[plan];
    const userId = req.user.id;

    if (req.user.balance < price) {
      return res.status(400).json({ error: `Insufficient balance. ${plan} plan costs GH₵${price}` });
    }

    // Plan hierarchy — gold > bronze > silver
    const hierarchy = { silver: 1, bronze: 2, gold: 3, none: 0 };
    if (hierarchy[req.user.premium_plan] >= hierarchy[plan]) {
      return res.status(400).json({ error: `You already have ${req.user.premium_plan} or a higher plan` });
    }

    const txId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);
    const newBalance = parseFloat(req.user.balance) - price;

    await pool.query('START TRANSACTION');
    try {
      await pool.query('UPDATE users SET balance = balance - ?, premium_plan = ?, premium_expires_at = ? WHERE id = ?',
        [price, plan, expiresAt, userId]);

      await pool.query(
        `INSERT INTO transactions (id, user_id, type, amount, balance_before, balance_after, status, provider)
         VALUES (?, ?, 'premium', ?, ?, ?, 'completed', 'internal')`,
        [txId, userId, price, req.user.balance, newBalance]
      );

      await pool.query(
        `INSERT INTO premium_subscriptions (user_id, plan, price_paid, expires_at, transaction_id)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, plan, price, expiresAt, txId]
      );

      await pool.query('COMMIT');
      logger.info(`Premium subscribed: user=${userId} plan=${plan}`);
      res.json({ message: `${plan} plan activated!`, plan, expiresAt, newBalance });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) { next(err); }
}

// POST /api/payments/stripe/webhook
async function stripeWebhook(req, res, next) {
  try {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripeVerifyWebhook(req.body, sig);
    } catch {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const { userId } = intent.metadata;
      const amount = intent.amount / 100;

      const [tx] = await pool.query(
        'SELECT * FROM transactions WHERE provider_ref = ?', [intent.id]
      );
      if (tx.length && tx[0].status === 'pending') {
        await pool.query('START TRANSACTION');
        try {
          await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
          const [u] = await pool.query('SELECT balance FROM users WHERE id = ?', [userId]);
          await pool.query(
            'UPDATE transactions SET status = ?, balance_after = ? WHERE provider_ref = ?',
            ['completed', u[0].balance, intent.id]
          );
          await pool.query('COMMIT');
          logger.info(`Stripe deposit confirmed: userId=${userId} amount=${amount}`);
        } catch (err) {
          await pool.query('ROLLBACK');
          throw err;
        }
      }
    }

    res.json({ received: true });
  } catch (err) { next(err); }
}

// GET /api/payments/transactions
async function getTransactions(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [rows] = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, status, provider, created_at
       FROM transactions WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) as total FROM transactions WHERE user_id = ?', [req.user.id]
    );

    res.json({ transactions: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

// Callback from MTN/Vodafone/AirtelTigo to confirm deposit
async function mobileMoneyCallback(req, res, next) {
  try {
    const { referenceId, status, provider } = req.body;
    if (!referenceId || !status) return res.status(400).json({ error: 'Missing fields' });

    const [tx] = await pool.query(
      'SELECT * FROM transactions WHERE provider_ref = ? AND type = ? AND status = ?',
      [referenceId, 'deposit', 'pending']
    );
    if (!tx.length) return res.status(404).json({ error: 'Transaction not found' });

    const transaction = tx[0];
    if (status === 'SUCCESSFUL' || status === 'success') {
      await pool.query('START TRANSACTION');
      try {
        await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?',
          [transaction.amount, transaction.user_id]);
        const [u] = await pool.query('SELECT balance FROM users WHERE id = ?', [transaction.user_id]);
        await pool.query(
          'UPDATE transactions SET status = ?, balance_after = ? WHERE id = ?',
          ['completed', u[0].balance, transaction.id]
        );
        await pool.query('COMMIT');
        logger.info(`${provider} deposit confirmed: txId=${transaction.id}`);
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    } else {
      await pool.query('UPDATE transactions SET status = ? WHERE id = ?', ['failed', transaction.id]);
    }

    res.json({ received: true });
  } catch (err) { next(err); }
}

module.exports = { deposit, withdraw, subscribePremium, stripeWebhook, getTransactions, mobileMoneyCallback };
