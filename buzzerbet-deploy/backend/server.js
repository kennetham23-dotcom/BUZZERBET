require('dotenv').config();
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const { testConnection } = require('./config/db');
const logger  = require('./config/logger');
const { initSocket } = require('./socket/gameSocket');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes    = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const gameRoutes    = require('./routes/games');
const adminRoutes   = require('./routes/admin');

let notificationRoutes = null;
try {
  notificationRoutes = require('./routes/notifications');
} catch {
  logger.warn('Push notification routes not loaded (web-push not installed)');
}

const app    = express();
const server = http.createServer(app);

// ── SOCKET.IO ─────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout:  20000,
  pingInterval: 10000,
});

initSocket(io);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // allow inline scripts in served HTML
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true,
}));

// Stripe webhook needs raw body — must be registered before express.json()
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limit
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests' },
  skip: (req) => req.path === '/health',
}));

// ── SERVE PWA STATIC FILES ────────────────────────────────────────────────
// public/ contains: index.html, sw.js, manifest.json, offline.html,
//                   admin.html, icons/, screenshots/
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
}));

// ── HEALTH CHECK ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    version:   process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    env:       process.env.NODE_ENV,
    memory:    process.memoryUsage().heapUsed,
  });
});

// ── API ROUTES ────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/payments',     paymentRoutes);
app.use('/api/games',        gameRoutes);
app.use('/api/admin',        adminRoutes);
if (notificationRoutes) {
  app.use('/api/notifications', notificationRoutes);
}

// ── SPA FALLBACK ──────────────────────────────────────────────────────────
// Serve index.html for any non-API, non-asset route
// so the PWA handles its own routing.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return next();
  }
  // Admin console
  if (req.path === '/admin' || req.path === '/admin.html') {
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }
  // Main PWA
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), err => {
    if (err) next(err);
  });
});

// ── ERROR HANDLING ────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await testConnection();

  server.listen(PORT, () => {
    logger.info(`🚀 BuzzerBet server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    logger.info(`🌐 Client origin: ${process.env.CLIENT_URL || '*'}`);
    logger.info(`📡 Socket.IO ready`);
    logger.info(`📂 Serving static files from: ${PUBLIC_DIR}`);
  });
}

start().catch(err => {
  logger.error('Failed to start server', { err: err.message });
  process.exit(1);
});

// Export for use in admin route (force-end game needs io)
module.exports = { app, server, io };
