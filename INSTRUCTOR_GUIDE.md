# Instructor Guide — Classroom Blockchain Lab

Use this for a live finance/classroom demo with **no Node server during class**. Students join from phones and laptops over WebRTC. The instructor’s browser is the hub (Admin-hosted mode).

## Before class (once)

1. Publish the static site (GitHub Pages):
   ```bash
   cd blockchain-demo
   npm install
   npm run build:static
   ```
   Push the `docs/` folder (or the whole repo) and enable **Settings → Pages → Deploy from branch → `/docs`**.

2. Note your lab URL, e.g. `https://YOUR_USER.github.io/The-Blockchain-Lab/lab/index.html`

3. Dry-run on campus Wi‑Fi: open the Pages URL on your laptop + one student phone. If peers never connect, use a phone hotspot for the demo (school networks often block WebRTC/trackers).

## Class day checklist

1. Open the lab URL on the **projector laptop** (Chrome or Edge).
2. Click **Create Session**. Leave that tab open — it is the classroom hub.
3. Write the **6-character code** on the board (or use the large Session Code on screen).
4. Students open the same lab URL → enter the code → **Participant (Mine)** or **Observer (Wallet)**.
5. On the admin dashboard, set difficulty (start at **2–3** leading zeros so blocks appear quickly).
6. Ask several miners to click **Start Mining**. Watch height / hashrate update live.
7. Optional teaching switch: set **Network Mode → Full P2P**, click **Update Settings**. Explain: messages now gossip peer-to-peer instead of through the instructor hub.
8. Optional: **Team Collusion / 51%** and **Hard Fork** panels for attack demos.

## Admin-hosted vs Full P2P

| Mode | What students experience | Best for |
|------|--------------------------|----------|
| **Admin-hosted** (default) | Instructor browser validates and relays blocks | Reliable class demo |
| **Full P2P** | Peers gossip blocks; local longest-chain acceptance | Teaching decentralization |

You can flip modes mid-session with **Update Settings**. Prefer Admin-hosted if the network is flaky.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Students stuck on “Waiting for initial chain…” | Confirm admin tab is still open; click **Open Test Miner Tab** on admin to verify locally |
| Peer count stays 0 across devices | Campus firewall blocking WebTorrent trackers / WebRTC — switch to hotspot |
| Admin refreshed and lost the room | Same join code restores chain from `localStorage` on that browser |
| Mining never finds a block | Lower leading zeros to 2 |
| GitHub Pages 404 on refresh of deep links | Use query sessions (`admin.html?session=CODE`) — the static build already does |

## Local prep without Pages

```bash
cd blockchain-demo
npm install
npm start
```

Open `http://localhost:3000/lab` — same Admin-hosted / Full P2P behavior; Express only serves files.

## After class

- Close the admin tab when done (session is browser-local; no cloud database).
- Re-run `npm run build:static` after code changes before pushing to Pages.
