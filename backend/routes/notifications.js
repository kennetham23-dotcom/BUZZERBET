const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { saveSubscription, removeSubscription, Notifications, sendToUser } = require('../services/pushService');

// POST /api/notifications/subscribe
router.post('/subscribe', authenticate, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    await saveSubscription(req.user.id, subscription);
    res.json({ message: 'Push subscription saved' });
  } catch (err) { next(err); }
});

// POST /api/notifications/unsubscribe
router.post('/unsubscribe', authenticate, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
    await removeSubscription(endpoint);
    res.json({ message: 'Unsubscribed' });
  } catch (err) { next(err); }
});

// POST /api/notifications/test  (dev only)
router.post('/test', authenticate, async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not available in production' });
  try {
    await sendToUser(req.user.id, Notifications.promotional('🔔 Test Notification', 'BuzzerBet push notifications are working!'));
    res.json({ message: 'Test notification sent' });
  } catch (err) { next(err); }
});

module.exports = router;
