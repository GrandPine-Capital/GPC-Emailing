const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');

function basicAuth(req, res, next) {
  if (!config.adminPassword) return next();
  const [scheme, value] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && value) {
    const [user, ...rest] = Buffer.from(value, 'base64').toString().split(':');
    const a = Buffer.from(`${user}:${rest.join(':')}`);
    const b = Buffer.from(`${config.adminUser}:${config.adminPassword}`);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Emailing"').status(401).send('Authentication required');
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Public: tracking pixels, click redirects, unsubscribe pages, inbound webhook,
  // and uploaded images (email clients must load them without credentials).
  app.use(require('./routes/public'));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '30d', fallthrough: false }));

  app.use(basicAuth);
  app.get('/shared/render-blocks.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'render-blocks.js')));
  app.use('/api', require('./routes/content'));
  app.use('/api', require('./routes/engage').router);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });
  return app;
}

module.exports = { createApp };
