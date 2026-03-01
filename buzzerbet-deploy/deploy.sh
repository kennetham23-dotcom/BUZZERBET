#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  BuzzerBet — One-Command VPS Deploy Script
#  Tested on Ubuntu 22.04 / 24.04
#
#  Usage:
#    chmod +x deploy.sh
#    ./deploy.sh yourdomain.com admin@yourdomain.com
# ═══════════════════════════════════════════════════════════════

set -e   # exit on any error

DOMAIN=${1:-""}
ADMIN_EMAIL=${2:-""}
APP_DIR="/opt/buzzerbet"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}══ $1 ══${NC}"; }

# ── Validate inputs ────────────────────────────────────────────
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: ./deploy.sh yourdomain.com admin@yourdomain.com"
  echo "  or:  ./deploy.sh 123.456.789.0 (IP address, no SSL)"
  exit 1
fi

USE_SSL=true
if [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  warn "IP address detected — skipping SSL setup"
  USE_SSL=false
fi

step "BuzzerBet Deploy — $DOMAIN"

# ── 1. System packages ──────────────────────────────────────────
step "Installing system dependencies"
apt-get update -qq
apt-get install -y -qq curl git nginx mysql-server certbot python3-certbot-nginx
log "System packages installed"

# ── 2. Node.js 20 ───────────────────────────────────────────────
step "Installing Node.js 20"
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version)')" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node $(node --version) ready"

# ── 3. PM2 ──────────────────────────────────────────────────────
step "Installing PM2 process manager"
npm install -g pm2 --quiet
log "PM2 $(pm2 --version) ready"

# ── 4. MySQL setup ──────────────────────────────────────────────
step "Configuring MySQL"
systemctl start mysql
systemctl enable mysql

# Generate random passwords
DB_PASS=$(openssl rand -hex 16)
DB_ROOT=$(openssl rand -hex 16)

mysql -u root -e "
  ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${DB_ROOT}';
  CREATE DATABASE IF NOT EXISTS buzzerbet CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS 'buzzerbet'@'localhost' IDENTIFIED BY '${DB_PASS}';
  GRANT ALL PRIVILEGES ON buzzerbet.* TO 'buzzerbet'@'localhost';
  FLUSH PRIVILEGES;
" 2>/dev/null || warn "MySQL root already configured — skipping password change"

log "MySQL ready"

# ── 5. App files ─────────────────────────────────────────────────
step "Setting up application"
mkdir -p $APP_DIR
cp -r . $APP_DIR/
cd $APP_DIR

# Generate secrets
JWT_SECRET=$(openssl rand -hex 64)

# Write .env
cat > .env <<EOF
NODE_ENV=production
PORT=3000
CLIENT_URL=https://${DOMAIN}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

DB_HOST=localhost
DB_PORT=3306
DB_USER=buzzerbet
DB_PASSWORD=${DB_PASS}
DB_NAME=buzzerbet

ADMIN_EMAIL=${ADMIN_EMAIL}

# Push notifications — run 'npm run vapid' then paste keys here
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Payment providers — add when ready
MTN_BASE_URL=https://sandbox.momodeveloper.mtn.com
MTN_ENVIRONMENT=sandbox
AIRTELTIGO_COUNTRY=GH
AIRTELTIGO_CURRENCY=GHS

PREMIUM_SILVER_PRICE=29
PREMIUM_BRONZE_PRICE=49
PREMIUM_GOLD_PRICE=79
GAME_DURATION_SECONDS=60
MATCHMAKING_TIMEOUT_MS=30000
MIN_STAKE=1
MAX_STAKE=10000
EOF

log ".env created with auto-generated secrets"

# ── 6. npm install ───────────────────────────────────────────────
step "Installing Node.js dependencies"
npm install --omit=dev --quiet
log "Dependencies installed"

# ── 7. Database migrations ───────────────────────────────────────
step "Running database migrations"
npm run migrate
npm run migrate:admin
log "Database migrated"

# ── 8. VAPID keys ────────────────────────────────────────────────
step "Generating VAPID keys for push notifications"
VAPID_OUTPUT=$(npm run vapid --silent 2>/dev/null || node -e "try{const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log('PUBLIC='+k.publicKey+'\nPRIVATE='+k.privateKey)}catch(e){}")
if [[ -n "$VAPID_OUTPUT" ]]; then
  VAPID_PUB=$(echo "$VAPID_OUTPUT" | grep PUBLIC | cut -d= -f2)
  VAPID_PRIV=$(echo "$VAPID_OUTPUT" | grep PRIVATE | cut -d= -f2)
  sed -i "s|VAPID_PUBLIC_KEY=|VAPID_PUBLIC_KEY=${VAPID_PUB}|" .env
  sed -i "s|VAPID_PRIVATE_KEY=|VAPID_PRIVATE_KEY=${VAPID_PRIV}|" .env
  # Inject public key into HTML files
  sed -i "s|window.BB_VAPID_KEY = ''|window.BB_VAPID_KEY = '${VAPID_PUB}'|" public/index.html
  sed -i "s|window.BB_VAPID_KEY = ''|window.BB_VAPID_KEY = '${VAPID_PUB}'|" public/admin.html
  log "VAPID keys generated and injected"
else
  warn "VAPID generation skipped — push notifications disabled"
fi

# Inject domain into HTML
sed -i "s|window.BB_API = ''|window.BB_API = ''|" public/index.html  # same-origin, no change needed

# ── 9. PM2 ───────────────────────────────────────────────────────
step "Starting app with PM2"
pm2 delete buzzerbet 2>/dev/null || true
pm2 start backend/server.js --name buzzerbet \
  --log /var/log/buzzerbet.log \
  --error /var/log/buzzerbet-error.log \
  --time \
  --max-memory-restart 500M \
  --restart-delay 3000
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash 2>/dev/null || true
log "App running on port 3000"

# ── 10. nginx ────────────────────────────────────────────────────
step "Configuring nginx"
cp nginx.conf /etc/nginx/sites-available/buzzerbet
sed -i "s/yourdomain.com/${DOMAIN}/g" /etc/nginx/sites-available/buzzerbet
ln -sf /etc/nginx/sites-available/buzzerbet /etc/nginx/sites-enabled/buzzerbet
rm -f /etc/nginx/sites-enabled/default

if [[ "$USE_SSL" == "false" ]]; then
  # Strip SSL blocks for IP-only deploy
  cat > /etc/nginx/sites-available/buzzerbet <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location /socket.io/ {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
    }
    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
    }
}
NGINX
fi

nginx -t && systemctl restart nginx && systemctl enable nginx
log "nginx configured"

# ── 11. SSL (domain only) ────────────────────────────────────────
if [[ "$USE_SSL" == "true" ]] && [[ -n "$ADMIN_EMAIL" ]]; then
  step "Obtaining SSL certificate"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect 2>/dev/null && \
    log "SSL certificate obtained" || \
    warn "SSL failed — domain may not point to this server yet. Run manually: certbot --nginx -d ${DOMAIN}"
fi

# ── 12. Firewall ─────────────────────────────────────────────────
step "Configuring firewall"
ufw allow OpenSSH 2>/dev/null || true
ufw allow 'Nginx Full' 2>/dev/null || true
ufw --force enable 2>/dev/null || true
log "Firewall configured"

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         BuzzerBet deployed successfully! 🎯          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Game:   ${BLUE}http${USE_SSL:+s}://${DOMAIN}/${NC}"
echo -e "  Admin:  ${BLUE}http${USE_SSL:+s}://${DOMAIN}/admin${NC}"
echo -e "  Health: ${BLUE}http${USE_SSL:+s}://${DOMAIN}/health${NC}"
echo ""
echo -e "  DB password (save this!): ${YELLOW}${DB_PASS}${NC}"
echo ""
if [[ -n "$ADMIN_EMAIL" ]]; then
  echo -e "  ${YELLOW}Next:${NC} Register at the game URL using ${ADMIN_EMAIL}"
  echo -e "        then run:  cd ${APP_DIR} && npm run migrate:admin"
fi
echo ""
echo -e "  Logs:   pm2 logs buzzerbet"
echo -e "  Status: pm2 status"
echo -e "  Restart: pm2 restart buzzerbet"
echo ""
