# Blockchain Lab - Deployment Guide

This guide covers deploying Blockchain Lab to various cloud platforms so your students can access it via a public URL.

## Quick Choice Guide

| Platform | Ease | Cost | Speed | Best For |
|----------|------|------|-------|----------|
| **Railway** | ⭐⭐⭐⭐⭐ | Free | 2 min | Beginners, quick start |
| **Render** | ⭐⭐⭐⭐ | Free | 3 min | Good free tier |
| **Vercel** | ⭐⭐⭐⭐ | Free | 2 min | Simple setup |
| **DigitalOcean App Platform** | ⭐⭐⭐ | $$$$ | 5 min | More control |
| **Heroku** | ⭐⭐⭐⭐ | $$$ | 3 min | Simple, paid |

**Recommendation: Railway** - Easiest, instant deploy, good free tier

---

## 1. Railway (RECOMMENDED - Easiest)

### Setup in 2 Minutes

**Step 1: Prepare Repository**
```bash
git add .
git commit -m "Blockchain Lab ready for deployment"
git push origin main
```

**Step 2: Deploy on Railway**
1. Go to [railway.app](https://railway.app)
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Connect your GitHub account
5. Select your blockchain-demo repository
6. Railway auto-detects Node.js and deploys!

**Step 3: Get Your URL**
- Railway assigns a public URL automatically
- Click the "Railway.app" domain in your dashboard
- Share this URL: `https://yourapp.railway.app/lab`

### After Deployment
```bash
# Your app is live! Visit:
https://yourapp.railway.app/lab  # Your students visit HERE

# Share this join codes work great
# Example: Share code "ABC123" and students join at
https://yourapp.railway.app/lab and enter code ABC123
```

### Production Settings (Optional)
In Railway dashboard:
- Add environment variable: `NODE_ENV=production`
- Monitor logs in real-time
- Auto-redeploys on git push

---

## 2. Render

### Setup in 3 Minutes

**Step 1: Prepare Code**
```bash
git push  # Make sure everything is committed
```

**Step 2: Create on Render**
1. Go to [render.com](https://render.com)
2. Click "New +"
3. Select "Web Service"
4. Connect GitHub account
5. Choose your repository
6. Configure:
   - **Name**: blockchain-lab
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Plan**: Free (all you need!)

**Step 3: Deploy**
- Click "Create Web Service"
- Render builds and deploys automatically
- Your URL appears on the dashboard

### Access Points
```
Admin URL: https://blockchain-lab.onrender.com/lab
Share this URL with your class for students to join
```

---

## 3. Vercel

### Setup in 2 Minutes

**Note**: Vercel is optimized for static sites. Use Railway or Render for best results with long-running processes.

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

Follow prompts. Your app is live at the provided URL.

---

## 4. Traditional VPS (DigitalOcean, AWS, Linode)

More control but requires more setup. Good for production.

### DigitalOcean App Platform

1. Go to [digitalocean.com](https://digitalocean.com)
2. Create account and add billing
3. "Create" > "App Platform"
4. Connect GitHub
5. Select repository
6. Configure and deploy
7. Assign domain if desired

Cost: $12/month for small droplet

---

## 5. Heroku (Legacy - Still Works)

```bash
# Install Heroku CLI
brew install heroku
# or windows: download from heroku.com/windows

# Login and deploy
heroku login
heroku create blockchain-lab-2024
git push heroku main
heroku open
```

Your app lives at: `https://blockchain-lab-2024.herokuapp.com/lab`

**Note**: Heroku free tier deprecated in 2022. Now requires paid plan ($7+/month)

---

## Post-Deployment Checklist

After deploying to any platform:

- [ ] Test admin creation: `https://yourapp.com/lab` → Click "Create Session"
- [ ] Test student join: Enter code from admin session
- [ ] Test observer view: Should show real-time updates
- [ ] Test participant mining: Should mine blocks
- [ ] Share URL with your class!

### Example for Students
```
Visit: https://your-deployed-app.com/lab
Code: ABCDEF
Choose: Observer or Participant
Click: Join
```

---

## Sharing With Your Class

### Email Template
```
Subject: Blockchain Lab - Distributed Ledger Activity

Dear Class,

Please visit: https://your-deployed-app.onrender.com/lab

Enter code: [CODE_FROM_ADMIN]

Choose your role:
- Observer: Watch the network (good for mobile)
- Participant: Mining (requires decent computer)

Then click "Join"

All updates are real-time through your browser!

Questions? Check the docs at:
http://github.com/your-username/blockchain-demo
```

### QR Code
```bash
# Generate QR code for your URL
# Use online tool: qr-code-generator.com
# Point to: https://your-deployed-app.com/lab
```

### Classroom Setup
1. **5 mins before class**: Create session and share code
2. **During class**: Monitor from admin dashboard
3. **Real-time adjustments**: Change difficulty, observe reactions
4. **After class**: URL keeps working, students can revisit

---

## Troubleshooting Deployment

### "WebSocket Connection Failed"
Some platforms don't support WebSockets by default:
- Railway ✅ Supported
- Render ✅ Supported  
- Vercel ❌ Not supported (use serverless alternative)
- Heroku ✅ Supported
- DigitalOcean ✅ Supported

### "App crashes after a while"
Likely memory leak. Monitor logs:
- Railway: Check "Logs" tab
- Render: View deploy logs
- Check for errors and restart

### "No real-time updates in frontend"
Usually a WebSocket firewall issue. Test:
```bash
# From student computer, open browser console:
# You should see "Connected to server" message
```

### "SSL/TLS issues"
Most platforms auto-provide HTTPS certificates - no action needed!

---

## Production Recommendations

### For Your Classroom:
1. **Use Railway** for simplicity
2. **Share shortened URL** (use bit.ly if URL is long)
3. **Create one session per class period**
4. **Lock parameters** after initial setup so students see consistency
5. **Save join codes** for reference

### Monitoring:
- Check platform logs daily for errors
- Monitor connected participants count
- Restart if you see performance degradation

### Scaling:
Current setup supports ~100 concurrent participants comfortably
- Railway auto-scales if needed (paid features)
- For larger deployments, add database persistence

---

## Next Steps

1. **Choose your platform** (Railway recommended!)
2. **Deploy your app**
3. **Test all features work**
4. **Create a session**
5. **Share the join code with students**
6. **Watch them learn blockchain!**

---

## Support

**Deployment Issues?**
- Check platform status page
- Review deployment logs
- Search platform documentation

**Lab Features Questions?**
- See [BLOCKCHAIN_LAB_README.md](BLOCKCHAIN_LAB_README.md)
- Check GitHub issues

**Test Deployment Locally First**
```bash
npm install
npm start
# Visit http://localhost:3000/lab
```

---

**You're now ready to teach blockchain to your students!** 🚀

