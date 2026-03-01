/**
 * BuzzerBet — Admin Migration
 * Adds is_admin column and push_subscriptions table.
 *
 * Run once: npm run migrate:admin
 */
require('dotenv').config({ path: '../.env' });
const mysql = require('mysql2/promise');

async function migrateAdmin() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  // Add is_admin to users (idempotent)
  try {
    await conn.query('ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE');
    console.log('✅ Added is_admin column to users');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('ℹ️  is_admin column already exists');
    } else throw err;
  }

  // Create push_subscriptions table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id     INT UNSIGNED NOT NULL,
      endpoint    VARCHAR(512) NOT NULL UNIQUE,
      p256dh      VARCHAR(255) NOT NULL,
      auth        VARCHAR(255) NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✅ push_subscriptions table ready');

  // Promote an admin by email (set ADMIN_EMAIL in .env)
  if (process.env.ADMIN_EMAIL) {
    const [r] = await conn.query(
      'UPDATE users SET is_admin = 1 WHERE email = ?', [process.env.ADMIN_EMAIL]
    );
    if (r.affectedRows > 0) {
      console.log(`✅ Promoted ${process.env.ADMIN_EMAIL} to admin`);
    } else {
      console.log(`⚠️  No user found with email: ${process.env.ADMIN_EMAIL} — register first, then re-run`);
    }
  } else {
    console.log('ℹ️  Set ADMIN_EMAIL in .env to auto-promote an admin on next run');
  }

  await conn.end();
  console.log('\n✅ Admin migration complete');
}

migrateAdmin().catch(err => {
  console.error('❌ Admin migration failed:', err.message);
  process.exit(1);
});
