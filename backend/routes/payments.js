const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  deposit, withdraw, subscribePremium, stripeWebhook,
  getTransactions, mobileMoneyCallback,
} = require('../controllers/paymentController');

// Stripe webhook needs raw body — must be before express.json()
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Callbacks from mobile money providers
router.post('/callback/momo', mobileMoneyCallback);

// Authenticated routes
router.use(authenticate);
router.post('/deposit', deposit);
router.post('/withdraw', withdraw);
router.post('/premium', subscribePremium);
router.get('/transactions', getTransactions);

module.exports = router;
