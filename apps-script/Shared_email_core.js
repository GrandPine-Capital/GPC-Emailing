// GENERATED from shared/ by scripts/sync-shared.js - edit the file in shared/ instead.
/*
 * Email helpers shared by the web app (window.EmailCore) and the Apps Script
 * worker (global EmailCore): merge tags, text conversion, validation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CONTACT_FIELDS = ['first_name', 'last_name', 'company', 'website', 'phone', 'country', 'industry'];

  const SAMPLE_CONTACT = {
    email: 'alex@example.com', first_name: 'Alex', last_name: 'Tan', company: 'Sample Sdn Bhd',
    country: 'Malaysia', industry: 'Information Technology', website: 'https://example.com',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function contactVars(contact) {
    const c = contact || {};
    return {
      email: c.email,
      first_name: c.first_name,
      last_name: c.last_name,
      full_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      company: c.company,
      website: c.website,
      phone: c.phone,
      country: c.country,
      industry: c.industry,
    };
  }

  /**
   * Replace {{tag}} / {{tag|fallback}} merge tags. Values are HTML-escaped when
   * opts.html is true (except *_url tags, which we generate ourselves).
   */
  function merge(text, vars, opts) {
    const html = !!(opts && opts.html);
    return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, function (_, key, fallback) {
      const value = vars[key];
      const out = value != null && value !== '' ? String(value) : fallback || '';
      return html && !/_url$/.test(key) ? escapeHtml(out) : out;
    });
  }

  function htmlToText(html) {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<div style="display:none[^"]*">[\s\S]*?<\/div>/gi, '')
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }

  const EMAIL_RE = /^[^\s@<>()[\]\\,;:"/]+@[^\s@<>()[\]\\,;:"/]+\.[a-z]{2,}$/i;
  function isEmail(s) {
    return EMAIL_RE.test(String(s || '').trim());
  }

  /** Firestore document id for a contact (the normalised email address). */
  function emailKey(email) {
    return String(email || '').trim().toLowerCase();
  }

  function normaliseTags(tags) {
    if (!tags) return [];
    const arr = Array.isArray(tags) ? tags : String(tags).split(/[,;|]/);
    const out = [];
    arr.forEach(function (t) {
      const v = String(t).trim();
      if (v && out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }

  /** Lower-case search tokens stored on each contact (for "search" filters). */
  function searchKeywords(c) {
    const words = [c.email, String(c.email || '').split('@')[0], String(c.email || '').split('@')[1], c.first_name, c.last_name, c.company]
      .join(' ')
      .toLowerCase()
      .split(/[\s,.;:()"'@/-]+/)
      .filter(function (w) { return w.length > 1; });
    if (c.email) {
      const e = String(c.email).toLowerCase();
      words.push(e, e.split('@')[1] || ''); // full address and domain, e.g. "acme.com"
    }
    return normaliseTags(words).slice(0, 40);
  }

  /**
   * Normalise a phone number to international digits for WhatsApp, e.g.
   * "012-345 6789" with default country code "60" -> "60123456789".
   */
  function phoneKey(phone, defaultCountryCode) {
    let d = String(phone || '').replace(/@.*$/, '').replace(/[^0-9+]/g, '');
    if (!d) return '';
    if (d.charAt(0) === '+') d = d.slice(1);
    else if (d.slice(0, 2) === '00') d = d.slice(2);
    else if (d.charAt(0) === '0' && defaultCountryCode) d = String(defaultCountryCode).replace(/\D/g, '') + d.slice(1);
    d = d.replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? d : '';
  }

  function addressOf(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return (m ? m[1] : String(from || '')).trim().toLowerCase();
  }

  /** Strip quoted history so keyword triggers only see what the contact wrote. */
  function stripQuoted(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From:\s/i.test(line)) break;
      if (/^\s*>/.test(line)) continue;
      out.push(line);
    }
    return out.join('\n').trim();
  }

  return {
    CONTACT_FIELDS: CONTACT_FIELDS, SAMPLE_CONTACT: SAMPLE_CONTACT, escapeHtml: escapeHtml, contactVars: contactVars,
    merge: merge, htmlToText: htmlToText, isEmail: isEmail, emailKey: emailKey, normaliseTags: normaliseTags,
    searchKeywords: searchKeywords, phoneKey: phoneKey, addressOf: addressOf, stripQuoted: stripQuoted,
  };
});
