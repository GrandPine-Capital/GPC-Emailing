/*
 * Polite website crawler that extracts publicly listed business email
 * addresses. Obeys robots.txt, uses timeouts and only visits a handful of
 * likely pages (home, contact, about, team) per site.
 */
const cheerio = require('cheerio');
const db = require('../../db');

const MAX_BYTES = 1.5 * 1024 * 1024;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const JUNK_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$|^(no-?reply|donotreply|mailer-daemon|postmaster)@|@(example|domain|email|yourdomain|yoursite|sentry|wixpress|sentry-next)\.|@[0-9.]+$|^[0-9a-f]{16,}@/i;
const CONTACT_HINTS = /contact|about|team|people|staff|enquir|inquir|reach|get-in-touch|hubungi|kontak|lianxi|联系|关于/i;

const userAgent = () => db.getSetting('crawler_user_agent') || 'EmailingLeadFinder/1.0';

async function fetchText(url, { timeout = 12000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent(), accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/text|html|xml/i.test(type)) throw new Error(`unsupported content-type ${type}`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), url: res.url || url };
}

// --- robots.txt -----------------------------------------------------------
const robotsCache = new Map();

function parseRobots(txt) {
  // Collect Disallow rules for "*" and for our own agent.
  const agent = userAgent().split('/')[0].toLowerCase();
  const rules = [];
  let applies = false;
  let sawRule = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      if (val === '*' || agent.includes(val.toLowerCase())) applies = true;
    } else if (key === 'disallow' || key === 'allow') {
      sawRule = true;
      if (applies && val) rules.push({ allow: key === 'allow', path: val });
    }
  }
  return rules;
}

function pathAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    const pattern = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (pattern.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

async function robotsAllowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      rules = parseRobots((await fetchText(`${u.origin}/robots.txt`, { timeout: 6000 })).text);
    } catch {
      rules = []; // no robots.txt -> allowed
    }
    robotsCache.set(u.origin, rules);
  }
  return pathAllowed(robotsCache.get(u.origin), u.pathname + u.search);
}

// --- extraction -----------------------------------------------------------
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function cleanEmail(e) {
  const email = decodeURIComponent(String(e)).trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return null;
  if (JUNK_RE.test(email)) return null;
  return email;
}

function extractEmails(html) {
  const $ = cheerio.load(html);
  const found = new Set();
  $('a[href^="mailto:" i]').each((_, el) => {
    const e = cleanEmail($(el).attr('href'));
    if (e) found.add(e);
  });
  $('[data-cfemail]').each((_, el) => {
    const e = cleanEmail(decodeCfEmail($(el).attr('data-cfemail')));
    if (e) found.add(e);
  });
  $('script, style, noscript').remove();
  const text = $.root().text().replace(/\s*(\[at\]|\(at\))\s*/gi, '@').replace(/\s*(\[dot\]|\(dot\))\s*/gi, '.');
  for (const m of text.match(EMAIL_RE) || []) {
    const e = cleanEmail(m);
    if (e) found.add(e);
  }
  return [...found];
}

function siteName($, url) {
  const og = $('meta[property="og:site_name"]').attr('content');
  const title = $('title').first().text();
  const name = (og || title || '').split(/\s[|\-–—:]\s/)[0].trim();
  return name.slice(0, 120) || new URL(url).hostname.replace(/^www\./, '');
}

function contactLinks($, base) {
  const origin = new URL(base).origin;
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const label = `${href} ${$(el).text()}`;
    if (!CONTACT_HINTS.test(label)) return;
    try {
      const u = new URL(href, base);
      if (u.origin === origin && /^https?:$/.test(u.protocol)) {
        u.hash = '';
        links.add(u.toString());
      }
    } catch {
      /* ignore malformed */
    }
  });
  return [...links];
}

/**
 * Crawl a company website for email addresses.
 * Returns { company, website, emails: [{ email, source_url }] }.
 */
async function crawlSite(startUrl, { maxPages = 4, delayMs = 500 } = {}) {
  let url = /^https?:\/\//i.test(startUrl) ? startUrl : `https://${startUrl}`;
  const origin = new URL(url).origin;
  const visited = new Set();
  const queue = [url, `${origin}/contact`, `${origin}/contact-us`, `${origin}/about`];
  const emails = new Map();
  let company = '';

  while (queue.length && visited.size < maxPages) {
    const next = queue.shift();
    const key = next.replace(/\/+$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      if (!(await robotsAllowed(next))) continue;
      const { text, url: finalUrl } = await fetchText(next);
      const $ = cheerio.load(text);
      if (!company) company = siteName($, finalUrl);
      for (const e of extractEmails(text)) if (!emails.has(e)) emails.set(e, finalUrl);
      if (visited.size === 1) {
        for (const link of contactLinks($, finalUrl)) if (!visited.has(link.replace(/\/+$/, ''))) queue.unshift(link);
      }
    } catch {
      /* page unavailable - keep going */
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  const host = new URL(origin).hostname.replace(/^www\./, '');
  // Emails on the company's own domain first.
  const list = [...emails].map(([email, source_url]) => ({ email, source_url }));
  list.sort((a, b) => Number(b.email.endsWith(host)) - Number(a.email.endsWith(host)));
  return { company, website: origin, emails: list };
}

module.exports = { crawlSite, extractEmails, fetchText, robotsAllowed, parseRobots, pathAllowed, cleanEmail, decodeCfEmail };
