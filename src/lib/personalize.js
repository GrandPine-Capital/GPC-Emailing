const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { renderDesign } = require('./render-blocks');

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function contactVars(contact = {}) {
  return {
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
    company: contact.company,
    website: contact.website,
    phone: contact.phone,
    country: contact.country,
    industry: contact.industry,
  };
}

/**
 * Replace {{tag}} / {{tag|fallback}} merge tags. Values are HTML-escaped when
 * `html` is true. Unknown tags with no fallback become an empty string.
 */
function merge(text, vars, { html = false } = {}) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_, key, fallback) => {
    const value = vars[key];
    const out = value != null && value !== '' ? String(value) : fallback || '';
    // URLs we generate are already safe; escape everything else in HTML context.
    return html && !key.endsWith('_url') ? escapeHtml(out) : out;
  });
}

function templateHtml(template) {
  if (!template) return '';
  if (template.mode === 'dragdrop') {
    const design = typeof template.design === 'string' ? db.json(template.design, null) : template.design;
    if (design) return renderDesign(design);
  }
  return template.html || '';
}

const sign = (value) => crypto.createHmac('sha256', config.appSecret).update(value).digest('hex').slice(0, 20);

function verify(value, sig) {
  const expected = sign(value);
  return typeof sig === 'string' && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Build the final, personalised email for one recipient: merge tags, a
 * guaranteed unsubscribe link, click-tracked links and an open pixel.
 */
function buildEmail({ html, subject, contact, token, track = true }) {
  const baseUrl = db.getSetting('base_url').replace(/\/+$/, '');
  const unsubscribeUrl = `${baseUrl}/u/${token}`;
  const vars = {
    ...contactVars(contact),
    unsubscribe_url: unsubscribeUrl,
    company_address: db.getSetting('company_address'),
    sender_name: db.getSetting('from_name'),
  };

  let body = merge(html, vars, { html: true });

  // Every marketing email must carry an unsubscribe link (CAN-SPAM, GDPR, PDPA).
  if (!body.includes(unsubscribeUrl)) {
    const address = vars.company_address ? `${escapeHtml(vars.company_address)}<br>` : '';
    const footer = `<div style="font:12px/1.5 Arial,sans-serif;color:#6b7280;text-align:center;padding:16px;">${address}<a href="${unsubscribeUrl}" style="color:#6b7280;">Unsubscribe</a></div>`;
    body = body.includes('</body>') ? body.replace('</body>', `${footer}</body>`) : body + footer;
  }

  if (track) {
    body = body.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (match, rawUrl) => {
      const url = rawUrl.replace(/&amp;/g, '&');
      if (url === unsubscribeUrl) return match;
      return `href="${baseUrl}/t/c/${token}?u=${encodeURIComponent(url)}&amp;s=${sign(url)}"`;
    });
    const pixel = `<img src="${baseUrl}/t/o/${token}.gif" width="1" height="1" alt="" style="display:none;border:0;">`;
    body = body.includes('</body>') ? body.replace('</body>', `${pixel}</body>`) : body + pixel;
  }

  return {
    subject: merge(subject, vars),
    html: body,
    text: htmlToText(merge(html, vars)) + `\n\nUnsubscribe: ${unsubscribeUrl}`,
    unsubscribeUrl,
  };
}

module.exports = { merge, templateHtml, buildEmail, sign, verify, htmlToText, contactVars, escapeHtml };
