/**
 * BuzzerBet PWA Integration Module
 *
 * Drop this into your main app's JS bundle or include as a script.
 * Handles:
 *  - Service worker registration & update flow
 *  - Install prompt (Add to Home Screen)
 *  - Push notification subscription
 *  - Network status banner
 *  - Periodic background sync registration
 */

const BuzzerPWA = (() => {

  // ── CONFIG ────────────────────────────────────
  const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY_HERE'; // Replace with your VAPID key
  const API_BASE = '';  // Same origin or set e.g. 'https://api.buzzerbet.com'

  // ── STATE ─────────────────────────────────────
  let swRegistration = null;
  let deferredInstallPrompt = null;
  let isOnline = navigator.onLine;

  // ── SERVICE WORKER REGISTRATION ───────────────
  async function registerSW() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[PWA] Service workers not supported');
      return;
    }

    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });

      console.log('[PWA] Service worker registered:', swRegistration.scope);

      // Check for updates every 60 seconds while app is open
      setInterval(() => swRegistration.update(), 60_000);

      // Handle SW update available
      swRegistration.addEventListener('updatefound', () => {
        const newWorker = swRegistration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });

      // Register periodic sync for balance refresh (if supported)
      if ('periodicSync' in swRegistration) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await swRegistration.periodicSync.register('refresh-balance', {
              minInterval: 5 * 60 * 1000, // Every 5 minutes
            });
            console.log('[PWA] Periodic sync registered');
          }
        } catch (err) {
          console.log('[PWA] Periodic sync not available:', err.message);
        }
      }

      return swRegistration;
    } catch (err) {
      console.error('[PWA] SW registration failed:', err);
    }
  }

  // ── INSTALL PROMPT ────────────────────────────
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] Install prompt captured');
    showInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hideInstallBanner();
    console.log('[PWA] App installed successfully');
    // Track install event
    fetch(`${API_BASE}/api/analytics/pwa-install`, { method: 'POST' }).catch(() => {});
  });

  async function triggerInstallPrompt() {
    if (!deferredInstallPrompt) return false;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log('[PWA] Install outcome:', outcome);
    deferredInstallPrompt = null;
    return outcome === 'accepted';
  }

  // ── INSTALL BANNER ────────────────────────────
  function showInstallBanner() {
    if (document.getElementById('pwa-install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
      <style>
        #pwa-install-banner {
          position: fixed;
          bottom: 0; left: 0; right: 0;
          z-index: 10000;
          background: linear-gradient(135deg, #0d0d1a, #1a1a2e);
          border-top: 1px solid rgba(255,215,0,0.3);
          padding: 16px 20px;
          display: flex;
          align-items: center;
          gap: 14px;
          box-shadow: 0 -8px 32px rgba(0,0,0,0.6);
          animation: slideUpBanner .3s ease;
        }
        @keyframes slideUpBanner {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        #pwa-install-banner .pwa-icon {
          width: 48px; height: 48px;
          background: linear-gradient(135deg, #B8860B, #FFD700);
          border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 24px; flex-shrink: 0;
        }
        #pwa-install-banner .pwa-text { flex: 1; }
        #pwa-install-banner .pwa-title {
          font-family: 'Orbitron', sans-serif;
          font-size: 13px; font-weight: 700;
          color: #FFD700; margin-bottom: 2px;
        }
        #pwa-install-banner .pwa-sub {
          font-family: 'Rajdhani', sans-serif;
          font-size: 12px; color: #6a6a8a;
        }
        #pwa-install-banner .pwa-btn-install {
          padding: 10px 18px;
          background: linear-gradient(135deg, #B8860B, #FFD700);
          color: #08090f;
          border: none;
          border-radius: 10px;
          font-family: 'Orbitron', sans-serif;
          font-size: 11px; font-weight: 700;
          letter-spacing: 1px;
          cursor: pointer;
          white-space: nowrap;
        }
        #pwa-install-banner .pwa-btn-dismiss {
          padding: 8px;
          background: transparent;
          border: none;
          color: #6a6a8a;
          font-size: 18px;
          cursor: pointer;
          line-height: 1;
        }
      </style>
      <div class="pwa-icon">★</div>
      <div class="pwa-text">
        <div class="pwa-title">INSTALL BUZZERBET</div>
        <div class="pwa-sub">Play faster · Works offline · No app store needed</div>
      </div>
      <button class="pwa-btn-install" onclick="BuzzerPWA.install()">INSTALL</button>
      <button class="pwa-btn-dismiss" onclick="BuzzerPWA.dismissInstall()">✕</button>
    `;
    document.body.appendChild(banner);
  }

  function hideInstallBanner() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.remove();
  }

  function dismissInstall() {
    hideInstallBanner();
    // Don't show again for 7 days
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
  }

  // ── UPDATE BANNER ─────────────────────────────
  function showUpdateBanner() {
    if (document.getElementById('pwa-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-update-banner';
    banner.innerHTML = `
      <style>
        #pwa-update-banner {
          position: fixed;
          top: 0; left: 0; right: 0;
          z-index: 10001;
          background: linear-gradient(135deg, #0d1a0d, #1a2e1a);
          border-bottom: 1px solid rgba(34,217,138,0.3);
          padding: 12px 20px;
          display: flex;
          align-items: center;
          gap: 12px;
          font-family: 'Rajdhani', sans-serif;
          font-size: 13px;
          color: #e8eaf0;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        #pwa-update-banner span { flex: 1; }
        #pwa-update-banner .upd-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #22d98a; box-shadow: 0 0 6px #22d98a;
          animation: pulse 2s infinite; flex-shrink: 0;
        }
        @keyframes pulse { 50%{opacity:.3} }
        #pwa-update-banner button {
          padding: 7px 14px;
          border-radius: 8px;
          border: 1px solid rgba(34,217,138,0.4);
          background: rgba(34,217,138,0.1);
          color: #22d98a;
          font-family: 'Orbitron', sans-serif;
          font-size: 10px; font-weight: 700;
          cursor: pointer;
          letter-spacing: 1px;
          white-space: nowrap;
        }
      </style>
      <div class="upd-dot"></div>
      <span>🚀 A new version of BuzzerBet is available!</span>
      <button onclick="BuzzerPWA.applyUpdate()">UPDATE NOW</button>
      <button onclick="this.parentElement.remove()" style="background:transparent;border:none;color:#6a6a8a;font-size:16px;cursor:pointer">✕</button>
    `;
    document.body.appendChild(banner);
  }

  async function applyUpdate() {
    if (!swRegistration || !swRegistration.waiting) return;
    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  }

  // ── PUSH NOTIFICATIONS ────────────────────────
  async function subscribePush(userToken) {
    if (!swRegistration || !('PushManager' in window)) {
      console.warn('[PWA] Push not supported');
      return null;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.log('[PWA] Push permission denied');
        return null;
      }

      // Check for existing subscription
      let subscription = await swRegistration.pushManager.getSubscription();

      if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      // Send subscription to backend
      await fetch(`${API_BASE}/api/notifications/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ subscription }),
      });

      console.log('[PWA] Push subscription active');
      return subscription;
    } catch (err) {
      console.error('[PWA] Push subscription failed:', err);
      return null;
    }
  }

  async function unsubscribePush(userToken) {
    if (!swRegistration) return;
    const subscription = await swRegistration.pushManager.getSubscription();
    if (!subscription) return;

    await subscription.unsubscribe();
    await fetch(`${API_BASE}/api/notifications/unsubscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    console.log('[PWA] Push unsubscribed');
  }

  // ── NETWORK STATUS ────────────────────────────
  function setupNetworkBanner() {
    const banner = document.createElement('div');
    banner.id = 'pwa-network-banner';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0;
      z-index: 9999; padding: 10px 20px;
      text-align: center;
      font-family: 'Rajdhani', sans-serif;
      font-size: 13px; font-weight: 600;
      letter-spacing: 1px;
      transition: transform .3s, opacity .3s;
      transform: translateY(-100%); opacity: 0;
    `;
    document.body.appendChild(banner);

    function showBanner(msg, color, bgColor) {
      banner.textContent = msg;
      banner.style.background = bgColor;
      banner.style.color = color;
      banner.style.borderBottom = `1px solid ${color}44`;
      banner.style.transform = 'translateY(0)';
      banner.style.opacity = '1';
    }

    function hideBanner() {
      banner.style.transform = 'translateY(-100%)';
      banner.style.opacity = '0';
    }

    window.addEventListener('offline', () => {
      isOnline = false;
      showBanner('📡 No internet connection — playing in offline mode', '#ff4560', '#1a0808');
    });

    window.addEventListener('online', () => {
      isOnline = true;
      showBanner('✅ Back online!', '#22d98a', '#081a0d');
      setTimeout(hideBanner, 2500);
    });
  }

  // ── BACKGROUND SYNC ───────────────────────────
  async function queueTapSync(gameId, count, token) {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;

    const db = await openDB();
    await addToStore(db, 'pendingTaps', { gameId, count, token, ts: Date.now() });
    await swRegistration.sync.register('sync-game-taps');
  }

  // ── SHARE API ─────────────────────────────────
  async function shareWin({ username, score, stake }) {
    const data = {
      title: 'I won on BuzzerBet!',
      text: `🏆 ${username} just won GH₵${stake} with ${score} taps on BuzzerBet! Think you can beat me? 👊`,
      url: 'https://buzzerbet.com',
    };

    if (navigator.share) {
      try { await navigator.share(data); }
      catch (err) { if (err.name !== 'AbortError') console.error(err); }
    } else {
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(`${data.text} ${data.url}`);
      alert('Share link copied to clipboard!');
    }
  }

  // ── VIBRATION ─────────────────────────────────
  function vibrateOnTap() {
    if ('vibrate' in navigator) navigator.vibrate(8);
  }

  function vibrateOnWin() {
    if ('vibrate' in navigator) navigator.vibrate([100, 50, 100, 50, 200]);
  }

  // ── SCREEN WAKE LOCK ──────────────────────────
  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[PWA] Wake lock acquired');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
      console.log('[PWA] Wake lock failed:', err.message);
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  }

  // Re-acquire wake lock when page becomes visible (e.g. after tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock === null) {
      requestWakeLock();
    }
  });

  // ── HELPERS ───────────────────────────────────
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('buzzerbet-sw', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('pendingTaps'))
          db.createObjectStore('pendingTaps', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function addToStore(db, storeName, item) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── INIT ──────────────────────────────────────
  async function init() {
    // Don't show install banner if dismissed recently
    const dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) {
      window.removeEventListener('beforeinstallprompt', showInstallBanner);
    }

    await registerSW();
    setupNetworkBanner();
    console.log('[PWA] BuzzerBet PWA module initialised');
  }

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── PUBLIC API ────────────────────────────────
  return {
    init,
    install: triggerInstallPrompt,
    dismissInstall,
    applyUpdate,
    subscribePush,
    unsubscribePush,
    shareWin,
    vibrateOnTap,
    vibrateOnWin,
    requestWakeLock,
    releaseWakeLock,
    queueTapSync,
    get isOnline() { return isOnline; },
    get swRegistration() { return swRegistration; },
  };
})();

// Make globally available
window.BuzzerPWA = BuzzerPWA;
