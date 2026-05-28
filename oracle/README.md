# Oracle Cloud Deployment Helpers

This folder contains ready-to-use configuration files for running Blockchain Lab on an Oracle Cloud Always Free VM (Ampere A1 ARM).

## Files

- `blockchain-lab.service` — systemd unit file (recommended over PM2 for servers)
- `nginx-blockchain-lab.conf` — Nginx reverse proxy config with proper WebSocket support

## Recommended Setup Flow on the VM

1. After cloning the repo and running `npm install`:
2. Copy the systemd service:
   ```bash
   sudo cp oracle/blockchain-lab.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable blockchain-lab
   sudo systemctl start blockchain-lab
   sudo systemctl status blockchain-lab
   ```
3. (Optional but recommended) Install nginx + use the nginx config for port 80/443 + Let's Encrypt or Cloudflare.

## Switching between PM2 and systemd

The project also includes `ecosystem.config.js` for PM2 if you prefer it.

## Health Check

The app exposes `GET /health` which returns uptime and status. Use this for monitoring.

## Notes

- The service assumes the user is `opc` (Oracle Linux default) and the app lives at `/home/opc/apps/blockchain-demo`.
- Adjust paths and user in the .service file if your setup differs.
- For Cloudflare Tunnel (easiest HTTPS), you don't need nginx — just run cloudflared pointing at localhost:3000.
