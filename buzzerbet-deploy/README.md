# 🎯 BuzzerBet — Production Deployment Guide

Real-time 1v1 tap betting game for Ghana. Players stake mobile money, tap a golden buzzer as fast as possible for 60 seconds — highest score wins double their stake.

---

## Project Structure

```
buzzerbet/
├── backend/                  ← Node.js / Express / Socket.io
│   ├── config/
│   │   ├── db.js             ← MySQL connection pool
│   │   ├── logger.js         ← Winston logger
│   │   ├── migrate.js        ← Initial DB schema
│   │   └── migrate-admin.js  ← Admin column + push_subscriptions
│   ├── controllers/
│   │   ├── authController.js ← Register / login / profile
│   │   └── paymentController.js ← Deposit / withdraw / premium / webhooks
│   ├── middleware/
│   │   ├── auth.js           ← JWT authenticate middleware
│   │   └── errorHandler.js   ← Global error + 404 handlers
│   ├── routes/
│   │   ├── auth.js           ← /api/auth/*
│   │   ├── payments.js       ← /api/payments/*
│   │   ├── games.js          ← /api/games/* (leaderboard, history)
│   │   ├── admin.js          ← /api/admin/* (all admin endpoints)
│   │   └── notifications.js  ← /api/notifications/* (push)
│   ├── services/
│   │   ├── gameService.js    ← In-memory matchmaking, game logic, scoring
│   │   ├── paymentService.js ← MTN MoMo, Vodafone Cash, AirtelTigo, Stripe
│   │   └── pushService.js    ← Web Push VAPID notifications
│   ├── socket/
│   │   └── gameSocket.js     ← Socket.io event handlers (patched w/ tap_batch)
│   └── server.js             ← Express app entry point
│
├── public/                   ← Static files served to browser
│   ├── index.html            ← Main PWA game app (fully wired)
│   ├── admin.html            ← Admin dashboard (fully wired)
│   ├── sw.js                 ← Service worker (cache, push, bg sync)
│   ├── manifest.json         ← PWA manifest (installable)
│   ├── pwa.js                ← PWA module (install prompt, push, network)
│   ├── offline.html          ← Offline fallback page
│   └── icons/                ← App icons (replace with real ones!)
│       ├── icon-72.png
│       ├── icon-96.png
│       ├── icon-128.png
│       ├── icon-144.png
│       ├── icon-152.png
│       ├── icon-192.png      ← Used by manifest + SW
│       ├── icon-384.png
│       └── icon-512.png      ← Used by manifest (maskable)
│
├── package.json
└── .env.example              ← Copy to .env and fill in values
```

---

## Step 1 — Prerequisites

- **Node.js** ≥ 18
- **MySQL** ≥ 8.0
- A domain with **HTTPS** (required for PWA install + service workers)
- Payment provider API keys (MTN MoMo developer portal, Vodafone, AirtelTigo, Stripe)

---

## Step 2 — Install Dependencies

```bash
npm install
```

---

## Step 3 — Configure Environment

```bash
cp .env.example .env
nano .env   # or use your editor of choice
```

**Required values to fill in:**

| Variable | Where to get it |
|---|---|
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `DB_PASSWORD` | Your MySQL root / user password |
| `MTN_COLLECTION_SUBSCRIPTION_KEY` | [MTN MoMo Developer Portal](https://momodeveloper.mtn.com) |
| `STRIPE_SECRET_KEY` | [Stripe Dashboard](https://dashboard.stripe.com/apikeys) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Run: `npm run vapid` |
| `ADMIN_EMAIL` | Email you'll register with as the first admin |

---

## Step 4 — Database Setup

```bash
# 1. Create database and tables
npm run migrate

# 2. Add admin column + push_subscriptions table
npm run migrate:admin
```

> ⚠️ **For `migrate:admin` to promote your admin:** First register an account at `/` using the email you set as `ADMIN_EMAIL`, then run `npm run migrate:admin` again.

---

## Step 5 — Generate App Icons

Replace the placeholder icons in `public/icons/` with real ones. Use [PWA Asset Generator](https://github.com/elegantapp/pwa-asset-generator):

```bash
npx pwa-asset-generator your-logo.png public/icons --manifest public/manifest.json
```

---

## Step 6 — Start the Server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Server listens on `http://localhost:3000` by default.

- **Game app:** `http://localhost:3000/`
- **Admin console:** `http://localhost:3000/admin`
- **Health check:** `http://localhost:3000/health`

---

## Step 7 — Production Deployment (Render / Railway / VPS)

### On Render.com:
1. Create a new **Web Service** → connect your repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add all `.env` variables in the Environment tab
5. Set `CLIENT_URL` to your Render URL (e.g. `https://buzzerbet.onrender.com`)

### On a VPS (Ubuntu) with nginx + PM2:

```bash
# Install PM2
npm install -g pm2

# Start app
pm2 start backend/server.js --name buzzerbet

# Auto-restart on reboot
pm2 save && pm2 startup

# nginx config (replace yourdomain.com)
# /etc/nginx/sites-available/buzzerbet
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";  # required for WebSocket
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# SSL certificate (free via Let's Encrypt)
sudo certbot --nginx -d yourdomain.com
```

---

## Step 8 — Mobile Money Webhooks

Each provider calls your server when a payment completes. Register these callback URLs in each provider's dashboard:

| Provider | Callback URL |
|---|---|
| MTN MoMo | `https://yourdomain.com/api/payments/callback/momo` |
| Vodafone | `https://yourdomain.com/api/payments/callback/momo` |
| AirtelTigo | `https://yourdomain.com/api/payments/callback/momo` |
| Stripe | `https://yourdomain.com/api/payments/stripe/webhook` |

For Stripe, also run:
```bash
stripe listen --forward-to https://yourdomain.com/api/payments/stripe/webhook
```

---

## Architecture Overview

```
Browser (PWA)
  │
  ├── HTTPS REST  ──► /api/auth/*          ← Register, login, profile
  │                   /api/payments/*      ← Deposit, withdraw, premium
  │                   /api/games/*         ← Leaderboard, history
  │                   /api/admin/*         ← Admin dashboard data
  │                   /api/notifications/* ← Push subscriptions
  │
  └── WebSocket   ──► Socket.io
                       matchmaking:join    ← Player enters queue
                       matchmaking:found   ← Opponent matched
                       game:start          ← Game begins (both players)
                       game:tap            ← Tap event (server-authoritative)
                       game:score_update   ← Your confirmed score
                       game:opp_score      ← Opponent's live score
                       game:activate_mult  ← Activate multiplier (validated vs plan)
                       game:mult_activated ← Server confirms multiplier
                       game:over           ← Result + new balance
```

---

## Multiplier Plans

| Plan | Price | Unlock |
|---|---|---|
| None (default) | — | ×1 only |
| Silver | GH₵29/mo | ×2 for 30s burst per game |
| Bronze | GH₵49/mo | ×3 for 30s burst per game |
| Gold | GH₵79/mo | ×4 for 30s burst per game |

Multipliers are validated server-side — clients cannot fake a higher plan.

---

## Admin Console

Access at `/admin`. Requires a user with `is_admin = 1` in the database.

**Features:**
- Dashboard: revenue, active users, live games, premium stats
- Revenue & games chart (7d / 30d / 90d)
- Payment provider split donut
- Live games panel (auto-refreshes every 10s, force-end button)
- Users: search, filter by status, view full profile, adjust balance, ban/unban
- Transactions: paginated with filters for type / status / user
- Game history: all finished/cancelled games
- Subscriptions: silver/bronze/gold breakdown with revenue

---

## Offline / PWA Features

- **Installable** (Add to Home Screen on Android/iOS)
- **Offline fallback** — shows branded offline page when no network
- **Background sync** — queued taps during brief disconnects sent on reconnect
- **Push notifications** — game results, deposit confirmations (requires VAPID keys)
- **Wake lock** — screen stays on during active games
- **Web Share API** — share win results to WhatsApp, Twitter, etc.
- **Periodic background sync** — balance refresh while app is backgrounded

---

## Security Notes

- All game logic is **server-authoritative** — tap counts, scores, multipliers, and balances are computed on the server, not trusted from the client
- Stakes are deducted via **MySQL transactions with `FOR UPDATE` row locks** — no double-spend possible
- JWT tokens expire in 7 days — refresh handled automatically
- Admin routes are protected by both JWT auth and `is_admin` flag check
- Rate limiting: 300 req/min globally, 10/15min on auth endpoints
- Passwords hashed with bcrypt (cost factor 12)
