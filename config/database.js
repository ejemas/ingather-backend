const { Pool, types } = require('pg');
require('dotenv').config();

// Fix: Override DATE parser to return raw string instead of JS Date
// This prevents timezone-related date shifting (e.g., 2026-04-14 becoming 2026-04-13)
types.setTypeParser(1082, (val) => val); // 1082 = DATE type OID

// Use DATABASE_URL if available (for production), otherwise use individual variables
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false
        }
      }
    : {
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