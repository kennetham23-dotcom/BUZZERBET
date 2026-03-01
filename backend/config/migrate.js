const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  // Create DB if not exists
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
  await conn.query(`USE \`${process.env.DB_NAME}\``);

  // ── USERS ──
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(120) NOT NULL UNIQUE,
      phone VARCHAR(20) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      premium_plan ENUM('none','silver','bronze','gold') NOT NULL DEFAULT 'none',
      premium_expires_at DATETIME NULL,
      total_wins INT UNSIGNED NOT NULL DEFAULT 0,
      total_losses INT UNSIGNED NOT NULL DEFAULT 0,
      total_games INT UNSIGNED NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_email (email),
      INDEX idx_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── GAMES ──
  await conn.query(`
    CREATE TABLE IF NOT EXISTS games (
      id VARCHAR(36) PRIMARY KEY,
      player1_id INT UNSIGNED NOT NULL,
      player2_id INT UNSIGNED NOT NULL,
      stake_amount DECIMAL(12,2) NOT NULL,
      player1_score INT UNSIGNED NOT NULL DEFAULT 0,
      player2_score INT UNSIGNED NOT NULL DEFAULT 0,
      player1_mult TINYINT NOT NULL DEFAULT 1,
      player2_mult TINYINT NOT NULL DEFAULT 1,
      winner_id INT UNSIGNED NULL,
      status ENUM('waiting','playing','finished','cancelled') NOT NULL DEFAULT 'waiting',
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (player1_id) REFERENCES users(id),
      FOREIGN KEY (player2_id) REFERENCES users(id),
      FOREIGN KEY (winner_id) REFERENCES users(id),
      INDEX idx_status (status),
      INDEX idx_player1 (player1_id),
      INDEX idx_player2 (player2_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── TRANSACTIONS ──
  await conn.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR(36) PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      type ENUM('deposit','withdrawal','stake','winnings','refund','premium') NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      balance_before DECIMAL(12,2) NOT NULL,
      balance_after DECIMAL(12,2) NOT NULL,
      status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
      provider ENUM('mtn','vodafone','airteltigo','stripe','internal') NOT NULL,
      provider_ref VARCHAR(255) NULL,
      phone VARCHAR(20) NULL,
      game_id VARCHAR(36) NULL,
      metadata JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      INDEX idx_user_id (user_id),
      INDEX idx_type (type),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── PREMIUM SUBSCRIPTIONS ──
  await conn.query(`
    CREATE TABLE IF NOT EXISTS premium_subscriptions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      plan ENUM('silver','bronze','gold') NOT NULL,
      price_paid DECIMAL(12,2) NOT NULL,
      starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      transaction_id VARCHAR(36) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('✅ All tables migrated successfully');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
