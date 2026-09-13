require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();

/* =========================================================
   ENVIRONMENT CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT) || 4000;

const MONGODB_URI = process.env.MONGODB_URI;

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

const JWT_SECRET = process.env.JWT_SECRET;

const ADMIN_USERNAME =
  String(process.env.ADMIN_USERNAME || 'admin')
    .trim()
    .toLowerCase();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const RESET_PASSWORD_TOKEN = process.env.RESET_PASSWORD_TOKEN;

/* =========================================================
   REQUIRED ENVIRONMENT VALIDATION
========================================================= */

if (!MONGODB_URI) {
  console.error(
    'Missing MONGODB_URI. Add MONGODB_URI to Render Environment Variables.'
  );
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error(
    'Missing JWT_SECRET. Add JWT_SECRET to Render Environment Variables.'
  );
  process.exit(1);
}

if (JWT_SECRET.length < 32) {
  console.error(
    'JWT_SECRET must be at least 32 characters long.'
  );
  process.exit(1);
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins =
  FRONTEND_ORIGIN === '*'
    ? true
    : FRONTEND_ORIGIN
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true
  })
);

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* =========================================================
   MONGOOSE JSON CONFIG
========================================================= */

const cleanJson = {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  }
};

/* =========================================================
   USER MODEL
========================================================= */

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
      },

      passwordHash: {
        type: String,
        required: true
      },

      passwordChangedAt: {
        type: Date,
        default: Date.now
      }
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   PRODUCT MODEL
========================================================= */

const Product = mongoose.model(
  'Product',
  new mongoose.Schema(
    {
      id: {
        type: String,
        required: true,
        unique: true,
        index: true
      },

      sku: {
        type: String,
        required: true,
        unique: true,
        trim: true
      },

      name: {
        type: String,
        required: true,
        trim: true
      },

      category: {
        type: String,
        required: true,
        trim: true
      },

      season: {
        type: String,
        required: true,
        trim: true
      },

      cost: {
        type: Number,
        required: true,
        min: 0
      },

      wsale: {
        type: Number,
        required: true,
        min: 0
      },

      retail: {
        type: Number,
        required: true,
        min: 0
      },

      minStock: {
        type: Number,
        default: 0,
        min: 0
      },

      unit: {
        type: String,
        default: 'pcs',
        trim: true
      },

      packSize: {
        type: Number,
        default: 1,
        min: 1
      },

      active: {
        type: Boolean,
        default: true
      }
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   CITY MODEL
========================================================= */

const City = mongoose.model(
  'City',
  new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        unique: true,
        trim: true
      }
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   CUSTOMER MODEL
========================================================= */

const Customer = mongoose.model(
  'Customer',
  new mongoose.Schema(
    {
      id: {
        type: String,
        required: true,
        unique: true,
        index: true
      },

      city: {
        type: String,
        required: true,
        trim: true
      },

      shop: {
        type: String,
        required: true,
        trim: true
      },

      owner: {
        type: String,
        required: true,
        trim: true
      },

      phone: {
        type: String,
        default: '',
        trim: true
      },

      address: {
        type: String,
        default: '',
        trim: true
      },

      opening: {
        type: Number,
        default: 0,
        min: 0
      },

      creditLimit: {
        type: Number,
        default: 0,
        min: 0
      }
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   VENDOR MODEL
========================================================= */

const Vendor = mongoose.model(
  'Vendor',
  new mongoose.Schema(
    {
      id: {
        type: String,
        required: true,
        unique: true,
        index: true
      },

      name: {
        type: String,
        required: true,
        trim: true
      },

      contact: {
        type: String,
        default: '',
        trim: true
      },

      phone: {
        type: String,
        default: '',
        trim: true
      },

      address: {
        type: String,
        default: '',
        trim: true
      },

      opening: {
        type: Number,
        default: 0,
        min: 0
      }
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   LEDGER MODEL
========================================================= */

const LedgerEntry = mongoose.model(
  'LedgerEntry',
  new mongoose.Schema(
    {
      id: {
        type: Number,
        required: true,
        unique: true,
        index: true
      },

      type: {
        type: String,
        required: true,
        index: true
      },

      date: {
        type: String,
        required: true,
        index: true
      },

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

      items: [
        {
          productId: String,
          qty: Number,
          price: Number,
          packQty: Number,
          lineId: String
        }
      ]
    },
    {
      timestamps: true,
      toJSON: cleanJson
    }
  )
);

/* =========================================================
   HELPERS
========================================================= */

function stripMongo(row) {
  const copy = { ...row };

  delete copy._id;
  delete copy.__v;
  delete copy.createdAt;
  delete copy.updatedAt;

  return copy;
}

async function readState() {
  const [
    products,
    cityDocs,
    customers,
    vendors,
    ledger
  ] = await Promise.all([
    Product.find().sort({ id: 1 }).lean(),

    City.find().sort({ name: 1 }).lean(),

    Customer.find()
      .sort({ city: 1, shop: 1 })
      .lean(),

    Vendor.find()
      .sort({ name: 1 })
      .lean(),

    LedgerEntry.find()
      .sort({ id: 1 })
      .lean()
  ]);

  return {
    products: products.map(stripMongo),

    cities: cityDocs.map(city => city.name),

    customers: customers.map(stripMongo),

    vendors: vendors.map(stripMongo),

    ledger: ledger.map(stripMongo)
  };
}

/* =========================================================
   JWT FUNCTIONS
========================================================= */

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const exp =
    Math.floor(Date.now() / 1000) +
    60 * 60 * 12;

  const body = {
    ...payload,
    exp
  };

  const encodedHeader = base64Url(
    JSON.stringify(header)
  );

  const encodedBody = base64Url(
    JSON.stringify(body)
  );

  const unsigned =
    `${encodedHeader}.${encodedBody}`;

  const signature =
    crypto
      .createHmac('sha256', JWT_SECRET)
      .update(unsigned)
      .digest('base64url');

  return `${unsigned}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');

    if (parts.length !== 3) {
      return null;
    }

    const [header, body, signature] = parts;

    const expected =
      crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');

    if (!safeEqual(signature, expected)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    );

    if (
      !payload.exp ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch (_error) {
    return null;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

/* =========================================================
   PASSWORD FUNCTIONS
========================================================= */

function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString('base64url')
) {
  const hash = crypto
    .pbkdf2Sync(
      password,
      salt,
      210000,
      32,
      'sha512'
    )
    .toString('base64url');

  return `pbkdf2_sha512$210000$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [
    algorithm,
    iterations,
    salt,
    hash
  ] = String(stored || '').split('$');

  if (
    algorithm !== 'pbkdf2_sha512' ||
    !iterations ||
    !salt ||
    !hash
  ) {
    return false;
  }

  const candidate = crypto
    .pbkdf2Sync(
      password,
      salt,
      Number(iterations),
      32,
      'sha512'
    )
    .toString('base64url');

  return safeEqual(candidate, hash);
}

function requireStrongPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8
  );
}

function publicUser(user) {
  return {
    username: user.username,
    passwordChangedAt: user.passwordChangedAt
  };
}

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function requireAuth(req, res, next) {
  const authorization =
    req.get('authorization') || '';

  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  const payload = verifyToken(token);

  if (!payload || !payload.sub) {
    return res
      .status(401)
      .json({
        error: 'Authentication required'
      });
  }

  req.user = payload;

  next();
}

/* =========================================================
   LOGIN RATE LIMITING
========================================================= */

const loginAttempts = new Map();

function checkLoginRate(req, res, next) {
  const key = req.ip;

  const now = Date.now();

  const attempt =
    loginAttempts.get(key) || {
      count: 0,
      resetAt:
        now + 15 * 60 * 1000
    };

  if (attempt.resetAt < now) {
    attempt.count = 0;

    attempt.resetAt =
      now + 15 * 60 * 1000;
  }

  attempt.count += 1;

  loginAttempts.set(key, attempt);

  if (attempt.count > 20) {
    return res
      .status(429)
      .json({
        error:
          'Too many login attempts. Try again later.'
      });
  }

  next();
}

/* =========================================================
   DATABASE STATE REPLACEMENT
========================================================= */

async function replaceCollection(
  Model,
  rows,
  key = 'id'
) {
  const ids = rows.map(row => row[key]);

  if (ids.length) {
    await Model.deleteMany({
      [key]: {
        $nin: ids
      }
    });
  } else {
    await Model.deleteMany({});
  }

  if (!rows.length) {
    return;
  }

  await Model.bulkWrite(
    rows.map(row => ({
      updateOne: {
        filter: {
          [key]: row[key]
        },

        update: {
          $set: row
        },

        upsert: true
      }
    }))
  );
}

/* =========================================================
   HEALTH ROUTE
========================================================= */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,

    db:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'connecting'
  });
});

/* =========================================================
   ROOT ROUTE
========================================================= */

app.get('/', (_req, res) => {
  res.json({
    ok: true,

    service:
      'Capital Hosiery Ledger API',

    health:
      '/api/health',

    state:
      '/api/state',

    auth:
      '/api/auth/login'
  });
});

/* =========================================================
   LOGIN
========================================================= */

app.post(
  '/api/auth/login',
  checkLoginRate,
  async (req, res, next) => {
    try {
      const username =
        String(
          req.body?.username || ''
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body?.password || ''
        );

      const user =
        await User.findOne({
          username
        });

      if (
        !user ||
        !verifyPassword(
          password,
          user.passwordHash
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              'Invalid username or password'
          });
      }

      const token = signToken({
        sub: user.id,
        username: user.username
      });

      res.json({
        token,
        user: publicUser(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  '/api/auth/me',
  requireAuth,
  async (req, res, next) => {
    try {
      const user =
        await User.findById(
          req.user.sub
        );

      if (!user) {
        return res
          .status(401)
          .json({
            error:
              'Authentication required'
          });
      }

      res.json({
        user: publicUser(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   CHANGE PASSWORD
========================================================= */

app.post(
  '/api/auth/change-password',
  requireAuth,
  async (req, res, next) => {
    try {
      const currentPassword =
        String(
          req.body?.currentPassword || ''
        );

      const newPassword =
        String(
          req.body?.newPassword || ''
        );

      if (
        !requireStrongPassword(
          newPassword
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'New password must be at least 8 characters'
          });
      }

      const user =
        await User.findById(
          req.user.sub
        );

      if (
        !user ||
        !verifyPassword(
          currentPassword,
          user.passwordHash
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              'Current password is incorrect'
          });
      }

      user.passwordHash =
        hashPassword(newPassword);

      user.passwordChangedAt =
        new Date();

      await user.save();

      const token = signToken({
        sub: user.id,
        username: user.username
      });

      res.json({
        token,
        user: publicUser(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   RESET PASSWORD
========================================================= */

app.post(
  '/api/auth/reset-password',
  async (req, res, next) => {
    try {
      const username =
        String(
          req.body?.username || ''
        )
          .trim()
          .toLowerCase();

      const resetToken =
        String(
          req.body?.resetToken || ''
        );

      const newPassword =
        String(
          req.body?.newPassword || ''
        );

      if (!RESET_PASSWORD_TOKEN) {
        return res
          .status(400)
          .json({
            error:
              'Password reset is not configured on the server'
          });
      }

      if (
        !requireStrongPassword(
          newPassword
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'New password must be at least 8 characters'
          });
      }

      if (
        !safeEqual(
          resetToken,
          RESET_PASSWORD_TOKEN
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              'Invalid reset token'
          });
      }

      const user =
        await User.findOne({
          username
        });

      if (!user) {
        return res
          .status(404)
          .json({
            error:
              'User not found'
          });
      }

      user.passwordHash =
        hashPassword(newPassword);

      user.passwordChangedAt =
        new Date();

      await user.save();

      const token = signToken({
        sub: user.id,
        username: user.username
      });

      res.json({
        token,
        user: publicUser(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   GET STATE
========================================================= */

app.get(
  '/api/state',
  requireAuth,
  async (_req, res, next) => {
    try {
      res.json(
        await readState()
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   UPDATE STATE
========================================================= */

app.put(
  '/api/state',
  requireAuth,
  async (req, res, next) => {
    try {
      const {
        products = [],
        cities = [],
        customers = [],
        vendors = [],
        ledger = []
      } = req.body || {};

      await Promise.all([
        replaceCollection(
          Product,
          products
        ),

        replaceCollection(
          City,
          cities.map(name => ({
            name
          })),
          'name'
        ),

        replaceCollection(
          Customer,
          customers
        ),

        replaceCollection(
          Vendor,
          vendors
        ),

        replaceCollection(
          LedgerEntry,
          ledger
        )
      ]);

      res.json(
        await readState()
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, _req, res, _next) => {
    console.error(
      'Server error:',
      error
    );

    res
      .status(500)
      .json({
        error:
          error.message ||
          'Server error'
      });
  }
);

/* =========================================================
   START DATABASE + SERVER
========================================================= */

async function startServer() {
  try {
    console.log(
      'Connecting to MongoDB...'
    );

    await mongoose.connect(
      MONGODB_URI
    );

    console.log(
      'MongoDB connected successfully.'
    );

    let existingAdmin =
      await User.findOne({
        username:
          ADMIN_USERNAME
      });

    if (!existingAdmin) {
      if (
        !ADMIN_PASSWORD ||
        !requireStrongPassword(
          ADMIN_PASSWORD
        )
      ) {
        console.error(
          'First startup needs ADMIN_PASSWORD with at least 8 characters.'
        );

        process.exit(1);
      }

      existingAdmin =
        await User.create({
          username:
            ADMIN_USERNAME,

          passwordHash:
            hashPassword(
              ADMIN_PASSWORD
            )
        });

      console.log(
        `Created admin user "${ADMIN_USERNAME}".`
      );
    } else {
      console.log(
        `Admin user "${ADMIN_USERNAME}" already exists.`
      );
    }

    const server =
      app.listen(
        PORT,
        '0.0.0.0',
        () => {
          console.log(
            `Capital Hosiery Ledger API running on port ${PORT}.`
          );
        }
      );

    server.on(
      'error',
      error => {
        if (
          error.code ===
          'EADDRINUSE'
        ) {
          console.error(
            `Port ${PORT} is already in use.`
          );

          process.exit(1);
        }

        console.error(
          'Server error:',
          error
        );

        process.exit(1);
      }
    );
  } catch (error) {
    console.error(
      'MongoDB connection failed:',
      error.message
    );

    process.exit(1);
  }
}

startServer();