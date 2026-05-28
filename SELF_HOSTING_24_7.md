# Blockchain Lab - Free 24/7 Self-Hosting Guide (Zero Ongoing Cost)

This guide shows you how to run **Blockchain Lab** 24/7 at no cost using only free tools. No recurring payments, no sleeping dynos.

## Important Note for Laptop Users

If your primary (or only) computer is a laptop you carry around, it will frequently be powered off, sleeping, or on battery. Running the site directly on that laptop + Cloudflare Tunnel will **not** give true 24/7 independent uptime.

The site will only be reachable when the laptop is:
- Powered on
- At home with internet
- Not sleeping

See the two practical paths below that actually deliver 24/7 when your laptop is traveling with you.

---

## Best Options When Your Laptop Travels

### Option A: Dedicated Low-Power Device Left at Home (Completely Card-Free)

Buy or repurpose one small device that stays plugged in 24/7 at your residence:

- Raspberry Pi 5 (recommended) — very low power (~5-7W idle)
- Used mini PC, Intel NUC, or thin client from eBay/Facebook Marketplace (~$50-120 one-time)
- An old desktop that lives at home

You use your laptop only for development and occasional management (via SSH or the web console). The website stays up even when your laptop is in your backpack.

This is the most popular solution for students who refuse recurring costs and credit cards.

### Option B: Oracle Cloud Always Free VM

See the dedicated **[ORACLE_CLOUD_SETUP.md](ORACLE_CLOUD_SETUP.md)**.

You get a real cloud server that runs 24/7 no matter where your laptop is. Your laptop is used only for SSH management when you have internet.

Trade-off: Signup usually requires a credit/debit card for verification only (no ongoing charges on Always Free resources).

---

## Self-Host + Cloudflare Tunnel Instructions (Use These on a Dedicated Device)

If you go with Option A (a device that actually stays powered on at home), the instructions below work perfectly. Just perform all the Linux/Windows steps on that dedicated machine instead of your traveling laptop.

**Why this is excellent when you have the right hardware**:
- Your app runs on hardware you control.
- Cloudflare Tunnel gives you a stable public HTTPS URL for free.
- Full native Socket.io support.
- Only ongoing cost is tiny electricity.

---

## Step-by-Step Setup (Windows)

### 1. Prepare the App on Your Host Machine

```powershell
# In PowerShell (run as normal user)
cd "C:\Users\brigh\College\Personal_Projects\Blockchain Demo\blockchain-demo"

# Install dependencies (if not already)
npm install

# (Optional but recommended) Install PM2 globally for easy process management
npm install -g pm2
```

Test it works:
```powershell
npm start
# Visit http://localhost:3000/lab in your browser
# Press Ctrl+C to stop
```

### 2. Install Cloudflare Tunnel (cloudflared)

**Easiest way on Windows:**
```powershell
winget install --id Cloudflare.cloudflared -e
```

Verify:
```powershell
cloudflared --version
```

Alternative: Download the .exe from https://github.com/cloudflare/cloudflared/releases and put it in your PATH.

### 3. Create a Cloudflare Account & Add Your Domain (or Use Free Subdomain)

**Option A (Recommended - Custom nice URL):**
1. Sign up for a free Cloudflare account: https://dash.cloudflare.com
2. Add a domain you own (or buy a cheap one for ~$10/year from any registrar — Namecheap, Cloudflare Registrar, Porkbun, etc.).
3. Change your domain's nameservers to Cloudflare's (takes 5-60 min to propagate).

**Option B (Quick test - random URL):**
You can use `cloudflared tunnel --url http://localhost:3000` for a temporary `*.trycloudflare.com` URL. Good for testing only.

### 4. Create a Named Tunnel

1. Go to Cloudflare Dashboard → **Zero Trust** (left menu) → **Networks** → **Tunnels**.
2. Click **Create a tunnel**.
3. Choose **Windows** as the operating system.
4. Name it something like `blockchain-lab`.
5. Copy the **Token** or the full `cloudflared service install ...` command shown.

**Alternative via CLI (advanced):**
```powershell
cloudflared tunnel login
cloudflared tunnel create blockchain-lab
```

### 5. Configure the Public Route

In the Tunnel dashboard for your new tunnel:

1. Click the tunnel → **Public Hostnames** tab.
2. Add a public hostname:
   - **Subdomain**: `blockchain-lab` (or whatever)
   - **Domain**: yourdomain.com (or the one you added)
   - **Service Type**: `HTTP`
   - **URL**: `localhost:3000`
3. Save.

You will now have `https://blockchain-lab.yourdomain.com/lab`

### 6. Run the Tunnel Persistently on Windows

**Best: Install as a Windows Service (starts on boot, survives logoff):**

Using the token from step 4:
```powershell
# Example (use your actual token)
cloudflared service install eyJhIjoi...YOUR_LONG_TOKEN_HERE...
```

Then start the service:
```powershell
# Or use services.msc GUI
sc start cloudflared
```

To uninstall service later: `cloudflared service uninstall`

**Alternative: Use PM2 for both App + Tunnel (simple)**

Create a combined ecosystem or run two PM2 processes.

### 7. Run Blockchain Lab Persistently with PM2 (Recommended)

From the project folder:

```powershell
# Start in production mode with auto-restart, logging, etc.
pm2 start ecosystem.config.js --env production

# Make PM2 start on Windows boot (important!)
pm2 save
pm2 startup
# Follow the instructions it prints (usually run a generated command as admin)
```

Useful PM2 commands:
```powershell
pm2 logs blockchain-lab          # View real-time logs
pm2 restart blockchain-lab
pm2 monit                        # Nice dashboard
pm2 status
```

### 8. (Optional but Strong) Use a .env for Production Settings

Edit `.env` (already present) and set:
```
NODE_ENV=production
PORT=3000
# Optionally lower difficulty for public demo if desired
# DIFFICULTY_LEADING_ZEROS=3
```

Restart PM2 after changes:
```powershell
pm2 restart blockchain-lab
```

### 9. Test Everything End-to-End

1. Ensure both PM2 app and cloudflared tunnel are running.
2. Visit your public URL: `https://blockchain-lab.yourdomain.com/lab`
3. Create a session.
4. Open on phone + another computer.
5. Join as participant and mine a block.
6. Verify real-time updates work across devices.

**Success!** Your site is now publicly accessible 24/7 at zero cost.

---

## Alternative: Oracle Cloud Always Free VM (Powerful "Set & Forget" Cloud)

If you prefer a real cloud server that stays on even if your home power/internet goes out (and you are OK providing a credit/debit card for **identity verification only** — no charges for Always Free resources):

1. Go to https://oracle.com/cloud/free
2. Sign up (provide valid email + card details for temporary $1 auth hold; refunded automatically).
3. Create an **Ampere A1** VM (4 OCPU / 24 GB RAM shape is free).
4. Choose a region with capacity (sometimes Ashburn or others have waitlists).
5. Install Ubuntu or Oracle Linux.
6. `ssh` in, install Node.js + git + nginx (optional) + PM2.
7. Clone this repo, `npm install`, use PM2 or systemd.
8. Open port 80/443 in Security Lists + install Certbot for HTTPS, **or** use Cloudflare Tunnel on the VM (even easier, no public IP exposure needed).

**Pros**: True cloud uptime, static public IP possible, very powerful hardware for free.
**Cons**: Signup friction (card), occasional "out of capacity" in popular regions, you manage the OS/updates.

Detailed guides: Search "Oracle Cloud Always Free Node.js 2026" — many excellent up-to-date YouTube/text tutorials exist.

---

## Quick "Keep-Alive" Hack for Paid Platforms (Not Truly Recommended)

If you already have a free Render / Railway / Fly.io instance and just want it to not sleep:

1. Deploy normally (see DEPLOYMENT.md).
2. Create a free UptimeRobot account (uptimerobot.com).
3. Add an HTTP(s) monitor to `https://your-app.onrender.com/lab` checking every 5 minutes.
4. This pings your app regularly → most platforms stay awake.

**Warning**: This is a workaround. WebSocket connections still drop during any rare cold starts. Some platforms' ToS discourage artificial traffic. Not as reliable as the options above.

---

## Maintenance & Best Practices

- **Updates**: `git pull`, `npm install`, `pm2 restart blockchain-lab`
- **Logs**: `pm2 logs` or check `./logs/` (if using the ecosystem config)
- **Monitoring uptime**: Use free UptimeRobot or similar pointed at your public URL.
- **Backups**: Your sessions are in-memory only. If the process restarts, active join codes and blockchains reset. This is by design for a classroom tool. For persistence across restarts, advanced users can add a simple JSON file saver (future enhancement).
- **Security**:
  - Keep Windows/Node updated.
  - Run as a limited user if possible.
  - Cloudflare Tunnel already gives you HTTPS + DDoS protection.
  - Consider adding a simple admin password in the future.
- **Resource usage**: Very light. One active class uses <100MB RAM + low CPU except when many students mine simultaneously.

---

## Troubleshooting

**"Tunnel not connecting"**
- Check `cloudflared` service status in Windows Services.
- Re-run the install command with your token.

**App restarts too much**
- Check `pm2 logs blockchain-lab` for crashes (usually a bug in a mining loop or bad custom validator JS from the attack demo).
- Increase `max_memory_restart` in ecosystem.config.js.

**Students can't connect in dorms**
- Cloudflare Tunnel solves 99% of these issues. No need for port forwarding.

**High CPU from mining**
- The difficulty settings in `.env` control this. Default 4 leading zeros + secondary 8 is reasonable for demos. Increase for slower mining.

---

## Summary - Your Zero-Cost 24/7 Stack

- **App**: This Blockchain Lab (Node + Express + Socket.io)
- **Process Manager**: PM2 (auto-restart, logs, boot persistence)
- **Public Exposure**: Cloudflare Tunnel (free HTTPS, no ports open, works everywhere)
- **Optional**: Oracle Cloud VM for when you want it off your personal hardware

You now have a production-grade, independent, always-available educational blockchain demo site at literally $0/month.

---

**Questions or issues?** Open an issue in the repo or refer to the main README.

**You did it!** Your website is now a real, independent service.
