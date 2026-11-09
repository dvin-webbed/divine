require('dotenv').config();
const { pool, initSchema } = require('./db');

async function main() {
  await initSchema();
  console.log('Database schema and investment tiers are ready.');
  await pool.end();
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
