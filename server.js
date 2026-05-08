const express = require('express');
const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'moon-dashboard-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Plaid ────────────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    }
  }
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Data storage ─────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      adminPassword: 'changeme',
      mustangGoal: 8000,
      cushion: 100,
      bills: [],
      ious: [],
      nightOutRequest: null,
      accounts: {
        bofa_checking: null,
        bofa_savings: null,
        greenlight_fun: null,
        greenlight_gas: null
      },
      accessTokens: []
    };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Plaid Link ───────────────────────────────────────────────────────────────
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'moon-user' },
      client_name: 'Moon Dashboard',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error('Link token error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not create link token' });
  }
});

app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token, account_label } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const data = loadData();
    if (!data.accessTokens) data.accessTokens = [];
    data.accessTokens.push({
      token: response.data.access_token,
      label: account_label || 'unknown',
      itemId: response.data.item_id
    });
    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('Exchange error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not connect account' });
  }
});

// ── Live status for Moon's screen ────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const data = loadData();
  const result = {
    funMoney: null,
    gasMoney: null,
    mustangFund: null,
    mustangGoal: data.mustangGoal || 8000,
    bills: data.bills || [],
    ious: data.ious || [],
    nightOutRequest: data.nightOutRequest,
    connected: false
  };

  if (!data.accessTokens || data.accessTokens.length === 0) {
    return res.json(result);
  }

  result.connected = true;

  // Pull balances from all connected accounts
  for (const tokenObj of data.accessTokens) {
    try {
      const balRes = await plaidClient.accountsBalanceGet({ access_token: tokenObj.token });
      const accounts = balRes.data.accounts;

      for (const acct of accounts) {
        const bal = acct.balances.available ?? acct.balances.current ?? 0;
        const label = tokenObj.label;
        const name = acct.name.toLowerCase();

        if (label === 'greenlight_fun') {
          result.funMoney = (result.funMoney || 0) + bal;
        } else if (label === 'greenlight_gas') {
          result.gasMoney = (result.gasMoney || 0) + bal;
        } else if (label === 'bofa_savings') {
          result.mustangFund = (result.mustangFund || 0) + bal;
        }
        // bofa_checking used for bill visibility — not displayed directly
      }
    } catch (e) {
      console.error(`Balance error for ${tokenObj.label}:`, e.response?.data || e.message);
    }
  }

  // Decision logic
  const bills = data.bills || [];
  const urgentBills = bills.filter(b => (parseInt(b.daysUntilDue) || 0) <= 3);
  const fun = result.funMoney ?? 0;

  let decision, headline, reason;

  if (fun <= 0) {
    decision = 'NO';
    headline = 'Fun money is empty.';
    reason = "You're out for today. Mom will add more tomorrow morning.";
  } else if (fun < 10 || urgentBills.length > 0) {
    decision = 'WAIT';
    headline = urgentBills.length > 0 ? 'A bill is due very soon.' : 'Running low.';
    reason = urgentBills.length > 0
      ? `${urgentBills[0].name} is due in ${urgentBills[0].daysUntilDue} day${urgentBills[0].daysUntilDue == 1 ? '' : 's'}. Think before you spend.`
      : `Only $${fun.toFixed(0)} left. Make it count.`;
  } else {
    decision = 'YES';
    headline = "You're good.";
    reason = `You have $${fun.toFixed(0)} in fun money today.`;
  }

  result.decision = decision;
  result.headline = headline;
  result.reason = reason;

  // Days to Friday
  const today = new Date();
  let daysToFriday = (5 - today.getDay() + 7) % 7;
  if (daysToFriday === 0) daysToFriday = 7;
  result.daysToFriday = daysToFriday;

  // Sunday night out button visibility
  const hour = today.getHours();
  const isSunday = today.getDay() === 0;
  result.showNightOutButton = isSunday && hour >= 20;

  res.json(result);
});

// ── IOU routes ───────────────────────────────────────────────────────────────
app.post('/api/iou/add', (req, res) => {
  const data = loadData();
  const { person, amount, description } = req.body;
  if (!person || !amount) return res.status(400).json({ error: 'Missing fields' });
  data.ious = data.ious || [];
  data.ious.push({
    id: Date.now(),
    person,
    amount: parseFloat(amount),
    description: description || '',
    date: new Date().toISOString().split('T')[0]
  });
  saveData(data);
  res.json({ success: true });
});

app.post('/api/iou/remove', (req, res) => {
  const data = loadData();
  const { id } = req.body;
  data.ious = (data.ious || []).filter(i => i.id !== parseInt(id));
  saveData(data);
  res.json({ success: true });
});

// ── Night out request ────────────────────────────────────────────────────────
app.post('/api/nightout/request', (req, res) => {
  const data = loadData();
  data.nightOutRequest = {
    requestedAt: new Date().toISOString(),
    status: 'pending',
    amount: 10
  };
  saveData(data);
  res.json({ success: true });
});

// ── Admin routes ─────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  const data = loadData();
  if (req.body.password === (data.adminPassword || 'changeme')) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Not logged in' });
}

app.get('/api/admin/data', requireAdmin, (req, res) => {
  const data = loadData();
  res.json({
    mustangGoal: data.mustangGoal || 8000,
    cushion: data.cushion || 100,
    bills: data.bills || [],
    ious: data.ious || [],
    nightOutRequest: data.nightOutRequest || null,
    connectedAccounts: (data.accessTokens || []).map(t => ({ label: t.label, itemId: t.itemId }))
  });
});

app.post('/api/admin/save', requireAdmin, (req, res) => {
  const data = loadData();
  data.mustangGoal = parseFloat(req.body.mustangGoal) || 8000;
  data.cushion = parseFloat(req.body.cushion) || 100;
  data.bills = (req.body.bills || []).map(b => ({
    name: b.name,
    amount: parseFloat(b.amount) || 0,
    daysUntilDue: parseInt(b.daysUntilDue) || 0
  }));
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/nightout/approve', requireAdmin, (req, res) => {
  const data = loadData();
  if (data.nightOutRequest) {
    data.nightOutRequest.status = 'approved';
    data.nightOutRequest.respondedAt = new Date().toISOString();
  }
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/nightout/decline', requireAdmin, (req, res) => {
  const data = loadData();
  if (data.nightOutRequest) {
    data.nightOutRequest.status = 'declined';
    data.nightOutRequest.respondedAt = new Date().toISOString();
  }
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/iou/remove', requireAdmin, (req, res) => {
  const data = loadData();
  const { id } = req.body;
  data.ious = (data.ious || []).filter(i => i.id !== parseInt(id));
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/disconnect', requireAdmin, (req, res) => {
  const data = loadData();
  const { itemId } = req.body;
  data.accessTokens = (data.accessTokens || []).filter(t => t.itemId !== itemId);
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const data = loadData();
  if (!req.body.newPassword || req.body.newPassword.length < 4) {
    return res.status(400).json({ error: 'Too short' });
  }
  data.adminPassword = req.body.newPassword;
  saveData(data);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Moon Dashboard running on port ${PORT}`));
