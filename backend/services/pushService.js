/**
 * BuzzerBet Push Notification Service
 * Handles VAPID key generation, subscription storage,
 * and sending push notifications to users.
 *
 * Install: npm install web-push
 */

const webpush = require('web-push');
const { pool } = require('../config/db');
const logger = require('../config/logger');

// Configure VAPID
webpush.setVapidDetails(
  'mailto:admin@buzzerbet.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── SUBSCRIPTION MANAGEMENT ───────────────────

async function saveSubscription(userId, subscription) {
  const endpoint = subscription.endpoint;
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [
      userId,
      endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
    ]
  );
  logger.info(`Push subscription saved: userId=${userId}`);
}

async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

async function getSubscriptions(userId) {
  const [rows] = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    [userId]
  );
  return rows.map(r => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
  }));
}

// ── SEND TO ONE USER ──────────────────────────

async function sendToUser(userId, payload) {
  const subscriptions = await getSubscriptions(userId);
  if (!subscriptions.length) return;

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, JSON.stringify(payload))
        .catch(async err => {
          // Remove expired/invalid subscriptions (410 = Gone, 404 = Not Found)
          if (err.statusCode === 410 || err.statusCode === 404) {
            await removeSubscription(sub.endpoint);
          }
          throw err;
        })
    )
  );

  const sent    = results.filter(r => r.status === 'fulfilled').length;
  const failed  = results.filter(r => r.status === 'rejected').length;
  logger.info(`Push sent to userId=${userId}: ${sent} ok, ${failed} failed`);
  return { sent, failed };
}

// ── SEND TO MULTIPLE USERS ────────────────────

async function sendToUsers(userIds, payload) {
  return Promise.allSettled(userIds.map(id => sendToUser(id, payload)));
}

// ── BROADCAST TO ALL ──────────────────────────

async function broadcast(payload) {
  const [subs] = await pool.query(
    'SELECT DISTINCT user_id FROM push_subscriptions'
  );
  return sendToUsers(subs.map(s => s.user_id), payload);
}

// ── NOTIFICATION TEMPLATES ────────────────────

const Notifications = {

  gameFound(opponentName, stake) {
    return {
      title: '⚡ Opponent Found!',
      body: `${opponentName} accepted your GH₵${stake} challenge. Tap now!`,
      tag: 'game-found',
      requireInteraction: true,
      actions: [
        { action: 'play', title: '▶ Play Now' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      url: '/?action=play',
      type: 'game_found',
    };
  },

  gameWon(opponentName, amount) {
    return {
      title: '🏆 You Won!',
      body: `You beat ${opponentName} and earned GH₵${amount}! 💰`,
      tag: 'game-result',
      url: '/?action=wallet',
      type: 'game_won',
    };
  },

  gameLost(opponentName) {
    return {
      title: '💀 Better Luck Next Time',
      body: `${opponentName} beat you this time. Try again?`,
      tag: 'game-result',
      url: '/',
      type: 'game_lost',
    };
  },

  depositConfirmed(amount, provider) {
    return {
      title: '✅ Deposit Confirmed',
      body: `GH₵${amount} has been added to your BuzzerBet balance via ${provider}.`,
      tag: 'deposit',
      url: '/?action=wallet',
      type: 'deposit',
    };
  },

  withdrawalSent(amount, phone) {
    return {
      title: '📤 Withdrawal Sent',
      body: `GH₵${amount} is on its way to ${phone}.`,
      tag: 'withdrawal',
      url: '/?action=wallet',
      type: 'withdrawal',
    };
  },

  premiumExpiring(plan, daysLeft) {
    return {
      title: '👑 Premium Expiring Soon',
      body: `Your ${plan} plan expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to keep your multiplier!`,
      tag: 'premium',
      url: '/?action=premium',
      type: 'premium_expiring',
    };
  },

  challengeReceived(fromUser, stake) {
    return {
      title: '🎯 Challenge Received!',
      body: `${fromUser} wants to battle you for GH₵${stake}. Accept?`,
      tag: 'challenge',
      requireInteraction: true,
      actions: [
        { action: 'accept', title: '✅ Accept' },
        { action: 'decline', title: '❌ Decline' },
      ],
      url: '/?action=matchmaking',
      type: 'challenge',
    };
  },

  promotional(title, body) {
    return { title, body, tag: 'promo', url: '/', type: 'promo' };
  },
};

// ── MYSQL TABLE MIGRATION ─────────────────────
// Add this to your migrate.js:
/*
  await conn.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      endpoint VARCHAR(512) NOT NULL UNIQUE,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
*/

module.exports = {
  saveSubscription,
  removeSubscription,
  getSubscriptions,
  sendToUser,
  sendToUsers,
  broadcast,
  Notifications,
};
