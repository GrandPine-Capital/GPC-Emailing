const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the app works without extra dependencies.
function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv();

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'emailing.db'),
  uploadsDir: env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  appSecret: env.APP_SECRET || 'change-me',
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 15000),
  // Defaults for values that are editable at runtime through the settings table.
  settingDefaults: {
    base_url: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
    smtp_host: env.SMTP_HOST || '',
    smtp_port: env.SMTP_PORT || '587',
    smtp_secure: env.SMTP_SECURE || 'false',
    smtp_user: env.SMTP_USER || '',
    smtp_pass: env.SMTP_PASS || '',
    from_name: env.FROM_NAME || 'My Company',
    from_email: env.FROM_EMAIL || 'hello@example.com',
    reply_to: env.REPLY_TO || '',
    company_address: env.COMPANY_ADDRESS || '',
    send_rate_per_minute: env.SEND_RATE_PER_MINUTE || '60',
    imap_host: env.IMAP_HOST || '',
    imap_port: env.IMAP_PORT || '993',
    imap_secure: env.IMAP_SECURE || 'true',
    imap_user: env.IMAP_USER || '',
    imap_pass: env.IMAP_PASS || '',
    imap_mailbox: env.IMAP_MAILBOX || 'INBOX',
    imap_poll_minutes: env.IMAP_POLL_MINUTES || '5',
    hunter_api_key: env.HUNTER_API_KEY || '',
    apollo_api_key: env.APOLLO_API_KEY || '',
    google_cse_key: env.GOOGLE_CSE_KEY || '',
    google_cse_cx: env.GOOGLE_CSE_CX || '',
    crawler_user_agent: env.CRAWLER_USER_AGENT || 'EmailingLeadFinder/1.0 (+contact: admin)',
  },
  secretSettings: ['smtp_pass', 'imap_pass', 'hunter_api_key', 'apollo_api_key', 'google_cse_key'],
};
