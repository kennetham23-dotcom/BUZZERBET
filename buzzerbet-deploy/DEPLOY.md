# BuzzerBet — Deploy Guide

Three ways to deploy. Pick one.

---

## Option A — Ubuntu VPS (Recommended for production)

**Best for:** DigitalOcean, Linode, Hetzner, AWS EC2, any Ubuntu server.  
**Cost:** ~$6/month (DigitalOcean Droplet)  
**Time:** ~10 minutes

### 1. Get a server

Buy a **$6/month Ubuntu 22.04 droplet** at [digitalocean.com](https://digitalocean.com).  
When asked for SSH key, add yours. Write down the server IP.

Point your domain to the server IP:
- Go to your domain registrar → DNS settings
- Add an **A record**: `@` → your server IP
- Add an **A record**: `www` → your server IP
- Wait 5–10 min for DNS to propagate

### 2. Upload the files

On your local machine:
```bash
scp buzzerbet-deploy.zip root@YOUR_SERVER_IP:/root/
```

### 3. SSH in and run one command

```bash
ssh root@YOUR_SERVER_IP

# Unzip
apt-get install -y unzip
unzip buzzerbet-deploy.zip
cd buzzerbet-deploy

# Make script executable and run
chmod +x deploy.sh
./deploy.sh yourdomain.com admin@yourdomain.com
```

That's it. The script installs Node, MySQL, nginx, gets an SSL cert, runs migrations, and starts the app with PM2.

### 4. Become admin

After the script finishes:
1. Go to `https://yourdomain.com` and **register** using the email you passed to the script
2. SSH back in and run:
   ```bash
   cd /opt/buzzerbet
   npm run migrate:admin
   ```
3. Go to `https://yourdomain.com/admin` — you're in

### Common commands after deploy
```bash
pm2 logs buzzerbet       # live logs
pm2 status               # check it's running
pm2 restart buzzerbet    # restart after config change
pm2 stop buzzerbet       # stop
```

---

## Option B — Railway (Fastest, free tier)

**Best for:** Testing, MVP launch, no server management.  
**Cost:** Free tier (500 hours/month), then ~$5/month  
**Time:** ~5 minutes

### 1. Push to GitHub

```bash
cd buzzerbet-deploy
git init
git add .
git commit -m "Initial BuzzerBet deploy"
# Create a repo at github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/buzzerbet.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
2. Select your `buzzerbet` repo
3. Railway auto-detects Node.js and deploys

### 3. Add MySQL

In Railway dashboard:
1. Click **+ New** → **Database** → **MySQL**
2. Click the MySQL service → **Connect** tab
3. Copy the connection variables

### 4. Set environment variables

In Railway dashboard → your app service → **Variables**. Add these (all required):

| Variable | Value |
|---|---|
| `JWT_SECRET` | Run locally: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `CLIENT_URL` | Your Railway URL (shown in Settings → Domains) |
| `DB_HOST` | From MySQL service connection details |
| `DB_PORT` | From MySQL service |
| `DB_USER` | From MySQL service |
| `DB_PASSWORD` | From MySQL service |
| `DB_NAME` | From MySQL service |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | Your email |

### 5. Run migrations

In Railway → your app → **Shell** tab:
```bash
npm run migrate
npm run migrate:admin
```

### 6. Generate VAPID keys (for push notifications)

In Railway shell:
```bash
npm run vapid
```
Copy the two keys and add them as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` env vars.

Then update `public/index.html` and `public/admin.html` — find `window.BB_VAPID_KEY = ''` and paste your public key. Commit and push.

---

## Option C — Docker (Any server with Docker)

**Best for:** Teams, existing Docker infrastructure, easy updates.

### 1. Upload files to your server

```bash
scp buzzerbet-deploy.zip root@YOUR_SERVER_IP:/root/
ssh root@YOUR_SERVER_IP
unzip buzzerbet-deploy.zip && cd buzzerbet-deploy
```

### 2. Create your .env

```bash
cp .env.template .env
nano .env
```

Fill in at minimum:
- `CLIENT_URL` — your domain (e.g. `https://yourdomain.com`)
- `JWT_SECRET` — run `openssl rand -hex 64`
- `DB_PASSWORD` — any strong password
- `DB_ROOT_PASSWORD` — any strong password
- `ADMIN_EMAIL` — your email

### 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 4. Launch

```bash
# Build and start everything (DB + migrations + app)
docker compose up -d --build

# Follow logs
docker compose logs -f app

# Run migrations (if migrate container already exited, re-run manually)
docker compose run --rm migrate
```

### 5. Set up nginx + SSL

```bash
apt-get install -y nginx certbot python3-certbot-nginx
cp nginx.conf /etc/nginx/sites-available/buzzerbet
sed -i 's/yourdomain.com/YOUR_ACTUAL_DOMAIN/g' /etc/nginx/sites-available/buzzerbet
ln -s /etc/nginx/sites-available/buzzerbet /etc/nginx/sites-enabled/
certbot --nginx -d yourdomain.com
```

### Useful Docker commands

```bash
docker compose ps                    # status
docker compose logs -f app           # live app logs
docker compose restart app           # restart after .env change
docker compose down                  # stop everything
docker compose pull && docker compose up -d --build  # update
```

---

## Adding Mobile Money (after launch)

The game works without payment providers — players just can't deposit/withdraw real money yet. Add them when ready:

### MTN MoMo
1. Register at [momodeveloper.mtn.com](https://momodeveloper.mtn.com)
2. Create a **Collection** app and a **Disbursement** app
3. Get your subscription keys and API credentials
4. Add to `.env`:
   ```
   MTN_COLLECTION_SUBSCRIPTION_KEY=your_key
   MTN_DISBURSEMENT_SUBSCRIPTION_KEY=your_key
   MTN_COLLECTION_API_USER=your_uuid
   MTN_COLLECTION_API_KEY=your_key
   MTN_DISBURSEMENT_API_USER=your_uuid
   MTN_DISBURSEMENT_API_KEY=your_key
   MTN_ENVIRONMENT=production   # change from sandbox when live
   ```
5. Register your callback URL in the MTN portal:  
   `https://yourdomain.com/api/payments/callback/momo`

### Vodafone Cash / AirtelTigo
Contact their business teams directly:
- Vodafone: developer.vodafone.com.gh
- AirtelTigo: Contact via their business portal

---

## After deploy checklist

- [ ] Game loads at `https://yourdomain.com`
- [ ] Can register and log in
- [ ] Can start matchmaking (two browser tabs)
- [ ] Tapping works and scores update in real-time  
- [ ] Game ends after 60s and result shows correctly
- [ ] Admin dashboard accessible at `/admin`
- [ ] "Install App" banner appears (PWA)
- [ ] App works offline (shows offline page)
- [ ] HTTPS padlock is green (SSL working)
