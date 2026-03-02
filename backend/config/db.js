const mysql = require('mysql2/promise');
require('dotenv').config();

const sslConfig = process.env.DB_SSL === 'true' ? {
  ssl: { rejectUnauthorized: false }
} : {};

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'buzzerbet',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
  connectTimeout: 30000,
  ...sslConfig,
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
