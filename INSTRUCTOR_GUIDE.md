# Blockchain Lab - Quick Start Guide for Instructors

Welcome! This guide gets you up and running with Blockchain Lab in your classroom.

## What You'll Need
- **Your computer** with Node.js installed (or cloud deployment)
- **5 minutes** to set up
- **A URL to share** with students (or local network)

## Local Setup (Quickest for Testing)

### 1. Install and Start
```bash
cd blockchain-demo
npm install
npm start
```

Your app runs at: `http://localhost:3000/lab`

### 2. Create Your First Session
1. Open `http://localhost:3000/lab` in your browser
2. Click **"Create Session"**
3. Your admin token will appear (save it!)
4. You'll see a **join code** (example: `ABC123`)

### 3. Test It
1. In another browser window/tab, go to `http://localhost:3000/lab`
2. Enter the join code (e.g., `ABC123`)
3. Choose "Observer" and click Join
4. You should see the blockchain loading

**Congrats!** You've got Blockchain Lab working! 🎉

---

## Deploy for Your Actual Class (Cloud)

For students to access from home, deploy to the cloud (takes ~5 minutes):

### Easiest Option: Railway

1. Go to [railway.app](https://railway.app)
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Connect your GitHub repository
5. Wait 2 minutes...
6. Railway gives you a public URL!

**Share this URL with your students:**
```
Visit: https://yourapp.railway.app/lab
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for step-by-step with other platforms.

---

## Running a Class Session

### Before Class (10 minutes)

1. **Navigate to the lab**
   ```
   http://localhost:3000/lab
   (or your cloud URL)
   ```

2. **Click "Create Session"**
   - Your admin token appears (save for later if needed)
   - A join code is generated (e.g., `BLOCKCHAIN`)

3. **Note the join code** - you'll give this to students

4. **Visit the admin dashboard** - you'll be redirected automatically

5. **Optional: Adjust settings**
   - Difficulty: 3-4 is good for 30 min of mining
   - Mining reward: 10 coins per block
   - Lock parameters: Check this if you don't want it changing during class

### During Class (30-60 minutes)

#### Step 1: Students Join (5 mins)
- Share the join code via email, Slack, or display on screen
- Each student:
  1. Goes to `http://localhost:3000/lab`
  2. Enters the join code
  3. Chooses **Observer** (safe for all devices) or **Participant** (desktop/laptop)
  4. Clicks "Join"

#### Step 2: Demonstrate Observer Mode (5 mins)
- Show students what they're seeing
- Point out:
  - Block height and count
  - Participant list
  - Real-time block additions
  - Network statistics

#### Step 3: Have Some Students Mine (15-20 mins)
- A few volunteers switch to "Participant" mode
- They click "Start Mining"
- Their computer searches for valid block hashes
- First to find one gets mining reward!
- Others watch in real-time

#### Step 4: Discuss What They See (10 mins)
- Why did mining take longer?
- Who mined the most blocks?
- What if everyone was mining?
- How does this compare to Bitcoin?

#### Step 5: Advanced: Demo Difficulty Change (Optional)
- You can increase difficulty mid-session
- Students watch mining time increase
- Illustrates why Bitcoin auto-adjusts

---

## Student Instructions (Give to Your Class)

### For Observers
```
1. Go to http://localhost:3000/lab (or your teacher's URL)
2. Enter code: [CODE_HERE]
3. Select: Observer
4. Click: Join
5. Watch the blockchain grow in real-time!
6. No special hardware needed. Works on mobile.
```

### For Participants (Mining)
```
1. Go to http://localhost:3000/lab (or your teacher's URL)
2. Enter code: [CODE_HERE]
3. Select: Participant
4. Click: Join
5. Set CPU Usage: 50% (so your computer doesn't get hot)
6. Click: Start Mining
7. Your computer will find blocks! Faster computer = more blocks
```

---

## Lesson Plans

### Lesson 1: What is a Blockchain? (30 mins)
1. **Explain** - Show the original demo at http://andersbrownworth.com/blockchain/
2. **Demonstrate** - Students observe blocks being mined
3. **Discuss** - Why is each block connected to the previous one?
4. **Activity** - "What if we changed block #3? What would break?"

### Lesson 2: Proof-of-Work Mining (45 mins)
1. **Explain** - How mining works (finding nonces)
2. **Demonstrate** - Students watch real mining happen
3. **Activity** - Have 3-4 students mine simultaneously
4. **Discussion** - Why does Bitcoin make mining harder over time?
5. **Challenge** - Increase difficulty mid-session, watch mining time increase

### Lesson 3: Network Economics (45 mins)
1. **Preview** - Mining rewards and transaction fees
2. **Activity** - Participant miners earn coins
3. **Transactions** - Miners send coins to each other
4. **Discussion** - Why do miners want rewards? Real-world incentives
5. **Analysis** - Who earned the most? Why?

### Lesson 4: 51% Attack (60 mins)
1. **Explain** - What's a 51% attack?
2. **Simulate** - Click "Initiate Team Collusion" on your Admin Dashboard
3. **Battle** - The class is automatically split into "Honest" and "Colluding" teams
4. **Attack Demo** - Watch the side-by-side network view as the teams race to build the longest chain
5. **Discuss** - Why is decentralization important?
6. **Connection** - How do real blockchains prevent this?

---

## FAQs

### Q: Will students' computers get damaged by mining?
**A:** No, the app limits CPU usage. At 50% (recommended), it's safe.

### Q: Why is one student's mining super slow?
**A:** Older/slower computers naturally find nonces slower. It's realistic!

### Q: Can students cheat?
**A:** No - all mining is verified by the network. Invalid blocks are rejected.

### Q: Why don't I see students' computers in real-time?
**A:** They're not visible - we only see their mined blocks and transactions.

### Q: How long does mining take?
**A:** Depends on difficulty and hardware. At difficulty 3: 5-30 seconds typical.

### Q: Can I run this from my laptop for a local class?
**A:** Yes! Use `npm start` and share `http://[yourcomputer'sIP]:3000/lab`

### Q: What if students disconnect?
**A:** No problem - they can rejoin anytime with the same code.

### Q: Can sessions be saved/replayed?
**A:** Currently no - sessions clear when server restarts. Future feature!

---

## Troubleshooting

### Students can't see real-time updates
- **Check**: WebSocket connections working
- **Fix**: Try refreshing the page
- **Or**: Use corporate network connection (some block WebSockets)

### Mining is extremely slow
- **Probably**: Difficulty is too high
- **Fix**: Decrease difficulty in admin panel
- **Or**: Increase block time target

### "Join code doesn't work"
- **Check**: Is it the right code?  
- **Fix**: Create a new session and get fresh code
- **Try**: Copy-paste instead of typing

### Students see old blockchain data
- **Cause**: Browser cache
- **Fix**: Hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
- **Or**: Clear browser cache

---

## Success Metrics

Your class is engaging with Blockchain Lab if:
- ✅ Students can successfully join
- ✅ Blocks are being mined live
- ✅ Students ask "how does this work?"
- ✅ Students see mining take different amounts of time
- ✅ Discussion happens about why decentralization matters

---

## Tips for Best Results

1. **Test beforehand** - Run locally first to see how it works
2. **Explain the join code** - Make sure students know where to enter it
3. **Start with observers** - Let them watch first, understand what's happening
4. **Then add miners** - Once they get the idea
5. **Be interactive** - Point out what's happening in real-time
6. **Ask questions** - "Why do you think mining took longer this time?"
7. **Make it relevant** - Connect to Bitcoin, banks, decentralization, etc.

---

## Next Steps

- **Test locally**: `npm start` → visit http://localhost:3000/lab
- **Deploy to cloud**: See [DEPLOYMENT.md](DEPLOYMENT.md)
- **Run your first session**: Gather your students and teach!
- **Iterate**: Adjust difficulty based on your class's pace

---

## Support

**Something not working?**
- Check README.md for technical details
- Review [DEPLOYMENT.md](DEPLOYMENT.md) for deployment issues
- Visit GitHub issues to search for your problem

**Teaching Questions?**
- Connect blockchain to real-world cryptocurrencies
- Discuss how Bitcoin uses these same concepts
- Explore economic incentives in decentralized systems

---

## Ready to Teach Blockchain? 🚀

You've got this! Your students are about to learn blockchain in the most interactive way possible.

**Happy teaching!**

---

**Credits**: Built on [Anders Brownworth's Blockchain Demo](http://andersbrownworth.com/blockchain/)
