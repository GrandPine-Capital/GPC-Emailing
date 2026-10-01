/* Background loop: campaign sending, automation steps, IMAP reply polling. */
const config = require('./config');
const db = require('./db');
const campaigns = require('./lib/campaigns');
const automations = require('./lib/automations');
const replies = require('./lib/replies');

let timer = null;
let running = false;
let lastImapPoll = 0;

async function tick() {
  if (running) return;
  running = true;
  try {
    await campaigns.processQueue();
    await automations.processDue();
    const every = Math.max(1, Number(db.getSetting('imap_poll_minutes')) || 5) * 60e3;
    if (Date.now() - lastImapPoll >= every) {
      lastImapPoll = Date.now();
      await replies.pollImap().catch((err) => console.error('[imap]', err.message));
    }
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, config.schedulerIntervalMs);
  setTimeout(tick, 1000);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
