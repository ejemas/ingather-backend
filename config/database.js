const { Pool, types } = require('pg');
require('dotenv').config();

// Fix: Override DATE parser to return raw string instead of JS Date
// This prevents timezone-related date shifting (e.g., 2026-04-14 becoming 2026-04-13)
types.setTypeParser(1082, (val) => val); // 1082 = DATE type OID

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const poolOptions = {
  max: parsePositiveInteger(process.env.PG_POOL_MAX, 15),
  idleTimeoutMillis: parsePositiveInteger(process.env.PG_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parsePositiveInteger(process.env.PG_CONNECTION_TIMEOUT_MS, 5000)
};

// Use DATABASE_URL if available (for production), otherwise use individual variables
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        ...poolOptions,
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false
        }
      }
    : {
        ...poolOptions,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      }
);

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
