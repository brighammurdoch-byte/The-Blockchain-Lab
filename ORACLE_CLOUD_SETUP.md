# Blockchain Lab on Oracle Cloud Always Free (24/7 Cloud Hosting)

This is currently the **best way** to get your Blockchain Lab running truly 24/7, independently of your laptop, at zero recurring cost.

Your laptop becomes just a management tool. The actual website runs on a free cloud virtual machine that stays powered on 24/7 even when your laptop is in your bag or powered off.

## Important Reality Check (2026)

- Oracle Cloud **Always Free** resources are genuinely free forever if you stay within limits.
- You will almost certainly need to provide a **real credit or debit card** during signup for identity verification (they place a temporary ~$1 authorization hold that drops automatically). No charges occur as long as you only use Always Free resources.
- If you absolutely cannot provide a card, the realistic alternatives are:
  - Buy a cheap always-on device (Raspberry Pi 5 or used mini PC) to leave at home (see updated SELF_HOSTING_24_7.md).
  - Accept that "laptop + Cloudflare Tunnel" only works when the laptop is on and connected.

If you're okay with the one-time card verification step, proceed.

## Why This Works Well for You

- The VM runs 24/7 in Oracle's data center.
- You get up to **4 OCPU + 24 GB RAM** (Ampere A1 shape) completely free — way more than needed.
- Your students can access the site from anywhere, anytime.
- You manage everything from your laptop via SSH or the web console whenever you have internet.
- Excellent performance for real-time Socket.io + mining simulations.

## Step-by-Step Oracle Cloud Setup

### 1. Sign Up for Oracle Cloud Free Tier

1. Go to: https://www.oracle.com/cloud/free/
2. Click **Sign up for free**.
3. Use a real email you control.
4. Fill in accurate personal information (name, address, phone).
5. When asked for payment method: provide a real debit or credit card (not prepaid/virtual cards in most cases).
   - They do a soft authorization (~$1) for verification only.
   - You will **not** be charged if you only use Always Free resources.
6. Choose your **home region** carefully (this cannot be easily changed later for free resources). Regions with good availability for Ampere A1:
   - US East (Ashburn)
   - US West (Phoenix)
   - Germany (Frankfurt)
   - Others — you may need to try a couple.
7. Complete verification (email + phone SMS).

**Tip**: If you get "out of capacity" errors later when creating the VM, try a different region or availability domain.

After signup you get both a 30-day $300 trial credit **and** perpetual Always Free resources.

### 2. Create Your Always Free VM (Ampere A1)

1. Log into the Oracle Cloud Console: https://cloud.oracle.com
2. Go to **Compute** → **Instances** → **Create Instance**.
3. Settings:
   - **Name**: `blockchain-lab`
   - **Image**: Oracle Linux 8 or Ubuntu 22.04/24.04 (both work well). Oracle Linux is slightly easier for Oracle tools.
   - **Shape**: Click **Change Shape**
     - Select **Ampere** (ARM)
     - Choose **VM.Standard.A1.Flex**
     - Set **OCPUs**: 4 (or start with 2 if you want headroom)
     - **Memory**: 24 GB (or 12-24)
   - **Boot volume**: 50 GB is plenty (Always Free allows up to 200 GB total).
   - **Networking**: Create a new Virtual Cloud Network (VCN) or use the default. **Assign a public IP address**.
4. **SSH keys**:
   - Generate a key pair on your laptop if you don't have one:
     ```powershell
     ssh-keygen -t ed25519 -C "oracle-blockchain" -f "$env:USERPROFILE\.ssh\oracle_key"
     ```
   - Upload the **public** key (`.pub` file) during instance creation.
5. Click **Create**.

Wait 1-3 minutes for the instance to become **Running**.

### 3. Connect to Your VM from Your Laptop

In the Oracle Console:
- Go to your instance → **Compute** → **Instance** details.
- Note the **Public IP**.
- Click the **Start Cloud Shell** button (or use your own terminal).

From your laptop PowerShell:

```powershell
# Replace with your actual public IP
ssh -i "$env:USERPROFILE\.ssh\oracle_key" opc@YOUR_VM_PUBLIC_IP
```

(On first connect you may need to accept the fingerprint.)

**Important usernames**:
- Oracle Linux → `opc`
- Ubuntu → `ubuntu`

### 4. Initial Server Setup (run these commands on the VM)

```bash
# Update everything
sudo dnf update -y          # Oracle Linux
# or
sudo apt update && sudo apt upgrade -y   # Ubuntu

# Install Node.js 20 (LTS) - works great on ARM
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -   # Oracle Linux / RHEL
# For Ubuntu:
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

sudo dnf install -y nodejs   # or sudo apt install -y nodejs

node --version
npm --version

# Install PM2 (process manager - keeps your app alive)
sudo npm install -g pm2

# Install git, nginx (optional but nice), and other tools
sudo dnf install -y git nginx   # adjust for Ubuntu (apt)
```

### 5. Deploy the Blockchain Lab App

```bash
# Clone your repo (you'll need to push your latest code to GitHub first, or use git archive / scp)
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/YOUR_USERNAME/blockchain-demo.git   # <-- change this
cd blockchain-demo

# Install dependencies
npm install

# Copy and customize environment
cp .env.example .env
nano .env   # or use vim
# Set:
# NODE_ENV=production
# PORT=3000
# DIFFICULTY_LEADING_ZEROS=3   (optional - easier for public demo)
# etc.
```

**Important**: Make sure your latest code (including the production improvements) is in the repo before cloning.

### 6. Run the App with PM2 (Production)

```bash
# Start the app
pm2 start ecosystem.config.js --env production

# Save PM2 process list and enable startup on VM reboot
pm2 save
pm2 startup systemd -u $USER --hp $HOME
# Follow the instructions it prints (usually one sudo command to run)

# Test it
pm2 logs blockchain-lab
```

You can now access the app directly via the VM's public IP on port 3000:
`http://YOUR_VM_IP:3000/lab`

### 7. Add HTTPS (Strongly Recommended)

Two good ways:

**Option A (Easiest): Use Cloudflare Tunnel on the VM** (recommended)
- This is the same Cloudflare Tunnel from the self-hosting guide.
- Your Oracle VM becomes the backend; Cloudflare gives you a nice domain + HTTPS + DDoS protection.
- No need to open extra ports or manage certificates.
- Follow the Cloudflare Tunnel steps from `SELF_HOSTING_24_7.md` but run `cloudflared` on the Oracle VM instead of your laptop.

**Option B: Nginx + Certbot (Let's Encrypt)**
```bash
sudo dnf install -y certbot python3-certbot-nginx
# Configure nginx reverse proxy to localhost:3000
# Then run certbot --nginx
```

### 8. Open Firewall / Security List

In the Oracle Cloud Console:
- Go to your instance → **Networking** → **Virtual Cloud Network** → **Security Lists**.
- Add an **Ingress Rule**:
  - Source: `0.0.0.0/0`
  - Protocol: TCP
  - Port: 3000 (or 80/443 if using nginx)
- If using Cloudflare Tunnel, you can keep port 3000 closed to the world and only allow the tunnel.

### 9. Monitoring & Maintenance

Useful commands on the VM:
```bash
pm2 logs blockchain-lab --lines 100
pm2 restart blockchain-lab
pm2 monit

# View system resources
htop          # (install with sudo dnf install htop)

# Reboot the VM safely from Oracle console or:
sudo reboot
```

**Health check**: Your app now has a `/health` endpoint. You can point free uptime monitors (UptimeRobot, etc.) at it.

### 10. Cost & Limits Awareness

- As long as you only run **one** Ampere A1 VM within the shape limits (4 OCPU / 24 GB total), **block storage ≤ 200 GB**, and **no other paid services**, you will not be billed after the trial.
- Monitor usage in the Console under **Billing & Cost Management**.
- Never create extra instances or upgrade shapes without understanding the pricing.

## Recommended Architecture for Your Use Case (Mobile Laptop)

Laptop (development + occasional admin via SSH)
        ↓
Oracle Cloud Always Free VM (runs 24/7)
        ↓
Cloudflare Tunnel (optional but nice) → Public HTTPS URL
        ↓
Students anywhere

Your laptop only needs to be online when you want to push code updates or check logs.

## Troubleshooting Common Oracle Issues

- **"Out of host capacity"**: Try different Availability Domain (AD-1, AD-2, AD-3) or a different region.
- **Can't SSH**: Check that the public IP is assigned and the security list allows port 22 from your IP (or 0.0.0.0/0 temporarily).
- **Node version issues on ARM**: Use the NodeSource script above — it works on aarch64.
- **App crashes on start**: Check `pm2 logs`. Common causes: port already in use, .env syntax, missing files after git clone.

## Next Steps

1. Decide if you're comfortable with the card verification step.
2. If yes — start at Step 1 above.
3. Push your current improved code to GitHub (or tell me and I can help package it).
4. Once the VM is running, I can help you with:
   - Exact nginx config
   - Cloudflare Tunnel setup on the VM
   - systemd service file instead of PM2 (if preferred)
   - Basic backup script for any future persistence

Would you like me to:
A) Generate a ready-to-use systemd service file + docker-compose for Oracle right now?
B) Create a detailed checklist tailored to your exact situation?
C) Walk you through the signup/VM creation interactively as you do it?
D) Explore the "buy a cheap Raspberry Pi / mini PC" route instead (completely card-free)?

Just tell me your preference (or any hard constraints like "no credit card whatsoever"), and I'll prepare the exact next files/steps.
