const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'server/server.js',
  'server/db.js',
  'server/UserPayoutEngine.js',
  'server/IllustrativePayoutCalculator.js',
  'server/YieldTrackerService.js',
  'server/PayoutQueueService.js',
  'server/investmentTerms.js',
  'server/InvestmentController.js',
  'server/routes/auth.js',
  'server/routes/portfolio.js',
  'public/index.html',
  'public/dashboard.html',
  '.env.example',
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(__dirname, '..', file)));
if (missing.length) {
  console.error('Missing required files:', missing.join(', '));
  process.exit(1);
}

console.log('Project structure check passed.');
