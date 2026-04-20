# Quick Start Guide - Blockchain Lab

## ✅ What Was Fixed

### 1. Session Code now visible on all dashboards
The join code is clearly displayed at the top of every dashboard so anyone in the session can see it.

### 2. Update Settings button now works
The admin token is properly stored in localStorage when you create a session, so the Update Settings button will work correctly.

### 3. All buttons tested and working
- Create Session ✅
- Join Session ✅
- Update Settings ✅
- All interface elements ✅

---

## How to Use

### Step 1: Create a Session (As Instructor)
1. Go to http://localhost:3000/lab/
2. Click blue "Create Session" button
3. **Your Admin Token will be displayed** - save this if you need to manage the session later
4. You'll be redirected to admin dashboard
5. **See the session code at the top** - This is what students need

### Step 2: Share the Code
- The 6-character code (e.g., "SBWEP9") at the top of your dashboard
- Students use this code to join your session

### Step 3: Students Join
1. Students go to http://localhost:3000/lab/
2. Enter the session code
3. Choose role:
   - **Observer** - Watch the blockchain, read-only
   - **Participant** - Mine blocks, send transactions
4. Click "Join" button
5. **They'll see the session code on their dashboard too**

### Step 4: Manage Settings (As Instructor)
1. On admin dashboard, adjust sliders:
   - Difficulty (Leading Zeros): How many leading zeros required
   - Difficulty (Secondary): Hex target value
   - Mining Reward: Coins awarded per block
2. Check "Lock parameters" to prevent changes
3. Click **"Update Settings"** button
4. See confirmation message ✅

### Step 5: Monitor the Network
- Watch participant list update as students join
- See real-time blockchain updates
- Monitor network statistics:
  - Block height
  - Total participants
  - Network hashrate
  - Time since last block

### Step 6: Advanced Features (Optional)
- **Start Attack**: Simulate 51% attack (if attacker has enough hashrate)
- **Pause Network**: Temporarily halt the network
- **Validator Code**: Students can view/modify block validation code
- **Demos**: Guided demonstrations of blockchain concepts

---

## File Locations

**Session Information Panel** (displays code on all dashboards):
- Admin view: Top of dashboard
- Observer view: Top of dashboard  
- Participant view: Top of dashboard

**Admin Token** (shown on admin dashboard):
- Use this if you need to manage settings from another session
- Keep it secure!

**Join Code** (shown on all dashboards):
- Share this with students
- Valid for the entire session lifetime

---

## Troubleshooting

**Q: Session code not showing?**
- Refresh the page
- Check browser console for errors
- Verify localStorage is enabled in browser

**Q: Update Settings button does nothing?**
- Verify admin token is showing on your dashboard
- Check browser console for network errors
- Server may need restart

**Q: Can't join with code?**
- Code is case-insensitive
- Make sure code is exactly 6 characters
- Create a new session if code is old

**Q: Students can't see real-time updates?**
- Check that WebSocket connections are working
- May be a network/firewall issue
- Refresh the page to reconnect

---

## Architecture Overview

```
Landing Page (/lab/)
    ↓
    ├─→ Create Session → Admin Dashboard
    │                    └─→ Manage settings, monitor network
    │
    └─→ Join with Code → Choose Role
                         ├─→ Observer → View-only dashboard
                         └─→ Participant → Full mining/transaction dashboard
```

**Real-time Communication**: WebSocket (Socket.io)
- Used for live blockchain updates
- Used for notification of new blocks
- Used for participant status updates

**Session Storage**:
- Admin Token: localStorage (admin only)
- Join Code: localStorage (all participants)
- User Info: sessionStorage (individual session)

---

## Key Features Explained

### Difficulty Settings
- **Leading Zeros**: How many zeros the block hash must start with (0-6)
- **Secondary**: Additional hex requirement (0x0 to 0xFFFF)
- Higher = harder mining = longer block times

### Lock Parameters
- When checked, admin cannot modify settings
- Prevents accidental changes during demonstration
- Must unlock to make changes

### Mining Reward
- Coins awarded to miner for each new block
- Affects participant balances
- Used for transaction validation

### 51% Attack
- Simulates majority hashrate attack
- Requires attacker to have >50% of network power
- Shows blockchain vulnerability principle

---

## Tips for Classroom Use

1. **Create a fresh session for each class**
   - Write the code on whiteboard for students
   - Display your admin dashboard on projector

2. **Adjust difficulty for class size**
   - More participants = higher difficulty recommended
   - Single participant = lower difficulty for faster blocks

3. **Lock parameters before starting**
   - Prevents accidental changes during lesson
   - Shows parameters cannot be changed (teaching point)

4. **Use observer mode for large classes**
   - Limits CPU usage
   - Everyone sees the same view
   - Good for demonstrations

5. **Use participant mode for smaller groups**
   - Interactive - students really mine
   - Can send transactions to each other
   - Hands-on learning about rewards and validation

---

## Mobile/Tablet Support

The interface is responsive but:
- Mining may be slow on mobile
- Desktop with multi-window view is ideal
- Use tablet + phone for student/instructor combo view

---

**Server Status**: Running at http://localhost:3000 ✅
**All Features**: Working and tested ✅
**Ready for Classroom**: Yes ✅

Happy teaching! 🎓⛓️
