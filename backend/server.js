require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RESET_PASSWORD_TOKEN = process.env.RESET_PASSWORD_TOKEN;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Add it to .env before starting the server.');
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing JWT_SECRET. Set a random value with at least 32 characters.');
  process.exit(1);
}

const allowedOrigins = FRONTEND_ORIGIN === '*'
  ? true
  : FRONTEND_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const cleanJson = {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  }
};

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  passwordChangedAt: { type: Date, default: Date.now }
}, { timestamps: true, toJSON: cleanJson }));

const Product = mongoose.model('Product', new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  sku: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  season: { type: String, required: true, trim: true },
  cost: { type: Number, required: true, min: 0 },
  wsale: { type: Number, required: true, min: 0 },
  retail: { type: Number, required: true, min: 0 },
  minStock: { type: Number, default: 0, min: 0 },
  unit: { type: String, default: 'pcs', trim: true },
  packSize: { type: Number, default: 1, min: 1 },
  active: { type: Boolean, default: true }
}, { timestamps: true, toJSON: cleanJson }));

const City = mongoose.model('City', new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true }
}, { timestamps: true, toJSON: cleanJson }));

const Customer = mongoose.model('Customer', new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  city: { type: String, required: true, trim: true },
  shop: { type: String, required: true, trim: true },
  owner: { type: String, required: true, trim: true },
  phone: { type: String, default: '', trim: true },
  address: { type: String, default: '', trim: true },
  opening: { type: Number, default: 0, min: 0 },
  creditLimit: { type: Number, default: 0, min: 0 }
}, { timestamps: true, toJSON: cleanJson }));

const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  contact: { type: String, default: '', trim: true },
  phone: { type: String, default: '', trim: true },
  address: { type: String, default: '', trim: true },
  opening: { type: Number, default: 0, min: 0 }
}, { timestamps: true, toJSON: cleanJson }));

const LedgerEntry = mongoose.model('LedgerEntry', new mongoose.Schema({
  id: { type: Number, required: true, unique: true, index: true },
  type: { type: String, required: true, index: true },
  date: { type: String, required: true, index: true },
  time: String,
  customerId: String,
  customerName: String,
  vendorId: String,
  productId: String,
  saleId: Number,
  purchaseId: Number,
  lineId: String,
  invoiceRef: String,
  method: String,
  shop: String,
  qty: Number,
  packQty: Number,
  amount: Number,
  paidNow: Number,
  price: Number,
  reason: String,
  notes: String,
  items: [{
    productId: String,
    qty: Number,
    price: Number,
    packQty: Number,
    lineId: String
  }]
}, { timestamps: true, toJSON: cleanJson }));

async function readState() {
  const [products, cityDocs, customers, vendors, ledger] = await Promise.all([
    Product.find().sort({ id: 1 }).lean(),
    City.find().sort({ name: 1 }).lean(),
    Customer.find().sort({ city: 1, shop: 1 }).lean(),
    Vendor.find().sort({ name: 1 }).lean(),
    LedgerEntry.find().sort({ id: 1 }).lean()
  ]);

  return {
    products: products.map(stripMongo),
    cities: cityDocs.map(c => c.name),
    customers: customers.map(stripMongo),
    vendors: vendors.map(stripMongo),
    ledger: ledger.map(stripMongo)
  };
}

function stripMongo(row) {
  const copy = { ...row };
  delete copy._id;
  delete copy.__v;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + (60 * 60 * 12);
  const body = { ...payload, exp };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha512').toString('base64url');
  return `pbkdf2_sha512$210000$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algo, iterations, salt, hash] = String(stored || '').split('$');
  if (algo !== 'pbkdf2_sha512' || !iterations || !salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha512').toString('base64url');
  return safeEqual(candidate, hash);
}

function publicUser(user) {
  return { username: user.username, passwordChangedAt: user.passwordChangedAt };
}

function requireAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const payload = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!payload || !payload.sub) return res.status(401).json({ error: 'Authentication required' });
  req.user = payload;
  next();
}

function requireStrongPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

const loginAttempts = new Map();
function checkLoginRate(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt < now) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  attempt.count += 1;
  loginAttempts.set(key, attempt);
  if (attempt.count > 20) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  next();
}

async function replaceCollection(Model, rows, key = 'id') {
  const ids = rows.map(row => row[key]);
  if (ids.length) await Model.deleteMany({ [key]: { $nin: ids } });
  else await Model.deleteMany({});

  if (!rows.length) return;
  await Model.bulkWrite(rows.map(row => ({
    updateOne: {
      filter: { [key]: row[key] },
      update: { $set: row },
      upsert: true
    }
  })));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'connecting' });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'Capital Hosiery Ledger API',
    health: '/api/health',
    state: '/api/state',
    auth: '/api/auth/login'
  });
});

app.post('/api/auth/login', checkLoginRate, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await User.findOne({ username });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.json({ token: signToken({ sub: user.id, username: user.username }), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.sub);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!requireStrongPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await User.findById(req.user.sub);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    user.passwordHash = hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    res.json({ token: signToken({ sub: user.id, username: user.username }), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const resetToken = String(req.body?.resetToken || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!RESET_PASSWORD_TOKEN) return res.status(400).json({ error: 'Password reset is not configured on the server' });
    if (!requireStrongPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (!safeEqual(resetToken, RESET_PASSWORD_TOKEN)) return res.status(401).json({ error: 'Invalid reset token' });
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.passwordHash = hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    res.json({ token: signToken({ sub: user.id, username: user.username }), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/state', requireAuth, async (_req, res, next) => {
  try {
    res.json(await readState());
  } catch (error) {
    next(error);
  }
});

app.put('/api/state', requireAuth, async (req, res, next) => {
  try {
    const { products = [], cities = [], customers = [], vendors = [], ledger = [] } = req.body || {};
    await Promise.all([
      replaceCollection(Product, products),
      replaceCollection(City, cities.map(name => ({ name })), 'name'),
      replaceCollection(Customer, customers),
      replaceCollection(Vendor, vendors),
      replaceCollection(LedgerEntry, ledger)
    ]);
    res.json(await readState());
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Server error' });
});

mongoose.connect(MONGODB_URI)
  .then(async () => {
    const existingAdmin = await User.findOne({ username: ADMIN_USERNAME.toLowerCase() });
    if (!existingAdmin) {
      if (!ADMIN_PASSWORD || !requireStrongPassword(ADMIN_PASSWORD)) {
        console.error('First startup needs ADMIN_PASSWORD with at least 8 characters.');
        process.exit(1);
      }
      await User.create({ username: ADMIN_USERNAME, passwordHash: hashPassword(ADMIN_PASSWORD) });
      console.log(`Created admin user "${ADMIN_USERNAME}".`);
    }
    const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Capital Hosiery ledger running on port ${PORT}`);
});
    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the existing server or change PORT in .env.`);
        process.exit(1);
      }
      throw error;
    });
  })
  .catch(error => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
