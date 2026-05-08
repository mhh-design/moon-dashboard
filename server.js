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
      accessTokens: []
    };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Bill due-date calculation ─────────────────────────────────────────────
function daysUntilNextDue(bill) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const freq = bill.frequency || 'monthly';

  if (freq === 'monthly') {
    const dom = parseInt(bill.dayOfMonth) || 1;
    let target = new Date(today.getFullYear(), today.getMonth(), dom);
    if (target <= today) target = new Date(today.getFullYear(), today.getMonth() + 1, dom);
    return Math.ceil((target - today) / 86400000);
  }

  if (freq === 'weekly') {
    const dow = parseInt(bill.dayOfWeek) || 0; // 0=Sun
    let diff = (dow - today.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return diff;
  }

  if (freq === 'biweekly') {
    // nextDueDate stored as ISO string, then repeats every 14 days
    if (!bill.nextDueDate) return 999;
    const next = new Date(bill.nextDueDate);
    next.setHours(0, 0, 0, 0);
    let diff = Math.ceil((next - today) / 86400000);
    while (diff < 0) diff += 14;
    if (diff === 0) diff = 14;
    return diff;
  }

  if (freq === 'quarterly') {
    // Bill is due on specific month+day, 4 times a year
    const dom = parseInt(bill.dayOfMonth) || 1;
    const startMonth = parseInt(bill.startMonth) || 0; // 0-based
    const months = [startMonth, startMonth+3, startMonth+6, startMonth+9].map(m => m % 12);
    const candidates = months.map(m => {
      let yr = today.getFullYear();
      let d = new Date(yr, m, dom);
      if (d <= today) d = new Date(yr + 1, m, dom);
      return d;
    });
    const next = candidates.reduce((a, b) => a < b ? a : b);
    return Math.ceil((next - today) / 86400000);
  }

  if (freq === 'annual') {
    const dom = parseInt(bill.dayOfMonth) || 1;
    const month = parseInt(bill.month) || 0; // 0-based
    let target = new Date(today.getFullYear(), month, dom);
    if (target <= today) target = new Date(today.getFullYear() + 1, month, dom);
    return Math.ceil((target - today) / 86400000);
  }

  return 999;
}

// ── Plaid ──────────────────────────────────────────────────────────────────
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

// ── Status ─────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const data = loadData();

  const bills = (data.bills || []).map(b => ({
    ...b,
    daysUntilDue: daysUntilNextDue(b)
  })).sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  const result = {
    funMoney: null,
    gasMoney: null,
    mustangFund: null,
    mustangGoal: data.mustangGoal || 8000,
    bills,
    ious: data.ious || [],
    nightOutRequest: data.nightOutRequest,
    connected: false
  };

  if (!data.accessTokens || data.accessTokens.length === 0) {
    return res.json(result);
  }

  result.connected = true;

  for (const tokenObj of data.accessTokens) {
    try {
      const balRes = await plaidClient.accountsBalanceGet({ access_token: tokenObj.token });
      for (const acct of balRes.data.accounts) {
        const bal = acct.balances.available ?? acct.balances.current ?? 0;
        if (tokenObj.label === 'greenlight_fun') result.funMoney = (result.funMoney || 0) + bal;
        else if (tokenObj.label === 'greenlight_gas') result.gasMoney = (result.gasMoney || 0) + bal;
        else if (tokenObj.label === 'bofa_savings') result.mustangFund = (result.mustangFund || 0) + bal;
      }
    } catch (e) {
      console.error(`Balance error for ${tokenObj.label}:`, e.response?.data || e.message);
    }
  }

  // Status strip
  const urgentBills = bills.filter(b => b.daysUntilDue <= 5);
  const warningBills = bills.filter(b => b.daysUntilDue <= 10);
  const fun = result.funMoney ?? 0;

  let statusColor, statusMessage;

  if (urgentBills.length > 0) {
    const b = urgentBills[0];
    statusColor = 'red';
    statusMessage = b.daysUntilDue <= 1
      ? `${b.name} is due today — be careful with spending`
      : `${b.name} is due in ${b.daysUntilDue} days — watch your spending`;
  } else if (fun < 5) {
    statusColor = 'red';
    statusMessage = 'Fun money is almost gone — Mom adds more tomorrow morning';
  } else if (warningBills.length > 0) {
    const b = warningBills[0];
    statusColor = 'yellow';
    statusMessage = `${b.name} is coming up in ${b.daysUntilDue} days`;
  } else {
    statusColor = 'green';
    statusMessage = "All bills are covered — you're good";
  }

  result.statusColor = statusColor;
  result.statusMessage = statusMessage;

  const today = new Date();
  let daysToFriday = (5 - today.getDay() + 7) % 7;
  if (daysToFriday === 0) daysToFriday = 7;
  result.daysToFriday = daysToFriday;

  const isSunday = today.getDay() === 0;
  result.showNightOutButton = isSunday && today.getHours() >= 20;

  res.json(result);
});

// ── IOUs ───────────────────────────────────────────────────────────────────
app.post('/api/iou/add', (req, res) => {
  const data = loadData();
  const { person, amount, description } = req.body;
  if (!person || !amount) return res.status(400).json({ error: 'Missing fields' });
  data.ious = data.ious || [];
  data.ious.push({ id: Date.now(), person, amount: parseFloat(amount), description: description || '', date: new Date().toISOString().split('T')[0] });
  saveData(data);
  res.json({ success: true });
});

app.post('/api/iou/remove', (req, res) => {
  const data = loadData();
  data.ious = (data.ious || []).filter(i => i.id !== parseInt(req.body.id));
  saveData(data);
  res.json({ success: true });
});

// ── Night out ──────────────────────────────────────────────────────────────
app.post('/api/nightout/request', (req, res) => {
  const data = loadData();
  data.nightOutRequest = { requestedAt: new Date().toISOString(), status: 'pending', amount: 10 };
  saveData(data);
  res.json({ success: true });
});

// ── Admin ──────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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
    frequency: b.frequency || 'monthly',
    dayOfMonth: parseInt(b.dayOfMonth) || 1,
    dayOfWeek: parseInt(b.dayOfWeek) || 0,
    nextDueDate: b.nextDueDate || '',
    startMonth: parseInt(b.startMonth) || 0,
    month: parseInt(b.month) || 0
  }));
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/nightout/approve', requireAdmin, (req, res) => {
  const data = loadData();
  if (data.nightOutRequest) { data.nightOutRequest.status = 'approved'; data.nightOutRequest.respondedAt = new Date().toISOString(); }
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/nightout/decline', requireAdmin, (req, res) => {
  const data = loadData();
  if (data.nightOutRequest) { data.nightOutRequest.status = 'declined'; data.nightOutRequest.respondedAt = new Date().toISOString(); }
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/iou/remove', requireAdmin, (req, res) => {
  const data = loadData();
  data.ious = (data.ious || []).filter(i => i.id !== parseInt(req.body.id));
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/disconnect', requireAdmin, (req, res) => {
  const data = loadData();
  data.accessTokens = (data.accessTokens || []).filter(t => t.itemId !== req.body.itemId);
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const data = loadData();
  if (!req.body.newPassword || req.body.newPassword.length < 4) return res.status(400).json({ error: 'Too short' });
  data.adminPassword = req.body.newPassword;
  saveData(data);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Moon Dashboard running on port ${PORT}`));
