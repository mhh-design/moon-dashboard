# Moon Dashboard

A personal financial dashboard showing fun money, gas card, Mustang Fund, bills, and IOUs in one screen.

## Setup Instructions

### Step 1 — Plaid (free, 20 min)
1. Go to dashboard.plaid.com and create a free account
2. Create an app called "Moon Dashboard"
3. Go to Team Settings → Keys
4. Copy your **Client ID** and **Sandbox secret**
5. When ready to connect real banks: request Development access, swap to Development secret

### Step 2 — Environment variables
Create a `.env` file in this folder OR set these in Render's dashboard:

```
PLAID_CLIENT_ID=your_client_id_here
PLAID_SECRET=your_secret_here
PLAID_ENV=sandbox
SESSION_SECRET=any-long-random-phrase-here
PORT=3000
```

### Step 3 — Run locally to test
```
npm install
npm start
```
Open http://localhost:3000

### Step 4 — Deploy to Render (~$7/month)
1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service → connect your GitHub repo
3. Add the environment variables in Render's dashboard
4. Deploy — you'll get a URL like https://moon-dashboard.onrender.com

### Step 5 — Connect accounts (in Admin panel)
Go to /admin, log in with password `changeme`, change the password immediately.

Connect accounts in this order:
1. **BofA Savings** → labeled "BofA Savings (Mustang Fund)"
2. **BofA Checking** → labeled "BofA Checking (bills/paycheck)"  
3. **Greenlight Fun Moon** → labeled "Greenlight — Fun Moon"
4. **Greenlight Gas Moon** → labeled "Greenlight — Gas Moon"

### Step 6 — His Android home screen
1. Open Chrome on his phone
2. Go to your Render URL
3. Tap three-dot menu → "Add to Home screen"
4. Done — one tap app icon

## How it works

**His screen (/):**
- Big YES / WAIT / NO at the top
- Fun money balance (today's Greenlight Fun card)
- Gas card balance (Greenlight Gas card)
- Mustang Fund with progress bar toward $8,000
- Upcoming bills
- Sunday night-out request button (visible Sundays after 8pm)
- IOU tracker — he logs when a friend covers him

**Your admin screen (/admin):**
- Password protected
- See and respond to night-out requests
- See all his IOUs
- Add/update upcoming bills with days until due
- Connect/disconnect bank accounts
- Change admin password

## Your daily routine
Every morning: open Greenlight app, check Fun Moon balance, if under $45 transfer $15.
Takes 30 seconds.

## Updating bills
Update "days until due" whenever a bill is paid or a new one comes up.
Takes 2 minutes once a week.

## Default admin password
`changeme` — change it immediately after first login.
