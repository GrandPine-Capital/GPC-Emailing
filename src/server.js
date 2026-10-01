const config = require('./config');
const db = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');
const scheduler = require('./scheduler');
const mailer = require('./lib/mailer');

db.init();
seed();

const app = createApp();
app.listen(config.port, () => {
  console.log(`Emailing running on http://localhost:${config.port}`);
  if (mailer.isDryRun()) console.log('No SMTP configured: running in DRY-RUN mode (emails are recorded, not delivered).');
  if (!config.adminPassword) console.log('Warning: ADMIN_PASSWORD is not set - the dashboard is not password protected.');
  scheduler.start();
});
