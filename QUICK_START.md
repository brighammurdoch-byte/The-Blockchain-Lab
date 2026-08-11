# Blockchain Lab — Quick Start

## Classroom (recommended)

1. Build & publish static site:
   ```bash
   cd blockchain-demo
   npm install
   npm run build:static
   ```
2. GitHub → Settings → Pages → Deploy from branch → folder **`/docs`**
3. Open `https://<user>.github.io/The-Blockchain-Lab/lab/index.html`
4. Instructor: **Create Session** (keep tab open) → share code
5. Students: join as Miner or Wallet

See [INSTRUCTOR_GUIDE.md](INSTRUCTOR_GUIDE.md) for the full class runbook (Admin-hosted vs Full P2P, troubleshooting).

## Local development

```bash
cd blockchain-demo
npm install
npm start
```

Open `http://localhost:3000/lab`

- Create Session uses **Admin-hosted** WebRTC by default (with BroadcastChannel mirror for same-origin tabs).
- On the admin page, use **Network Mode** to switch to **Full P2P**.
- **Open Test Miner Tab** opens a second miner for a quick same-machine check.

## Notes

- No backend session database — the instructor browser holds the chain.
- School Wi‑Fi may block WebRTC; use a hotspot if peers cannot connect.
- After code changes: re-run `npm run build:static` before pushing Pages.
