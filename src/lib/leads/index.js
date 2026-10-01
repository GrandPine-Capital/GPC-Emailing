/*
 * Lead finder orchestrator: for every selected country x industry, discover
 * company websites (web search and/or data portals, or user-supplied URLs),
 * then collect emails (Hunter domain search and/or crawling the website).
 */
const db = require('../../db');
const crawler = require('./crawler');
const search = require('./search');
const providers = require('./providers');
const { countryName } = require('./countries');

const deps = { crawler, search, providers };

function createSearch(params) {
  const res = db.run('INSERT INTO lead_searches (params, status) VALUES (?, ?)', JSON.stringify(params), 'running');
  return Number(res.lastInsertRowid);
}

function progress(searchId, text) {
  const n = db.get('SELECT COUNT(*) n FROM leads WHERE search_id = ?', searchId).n;
  db.run('UPDATE lead_searches SET progress = ?, results_count = ? WHERE id = ?', text, n, searchId);
  return n;
}

function saveLead(searchId, lead) {
  const res = db.run(
    `INSERT OR IGNORE INTO leads (search_id, email, first_name, last_name, position, company, website, country, industry, source, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    searchId, String(lead.email).toLowerCase(), lead.first_name || '', lead.last_name || '', lead.position || '',
    lead.company || '', lead.website || '', lead.country || '', lead.industry || '', lead.source || '', lead.source_url || '',
  );
  return res.changes > 0;
}

/**
 * params: {
 *   countries: ['MY', ...], industries: ['Real Estate', ...], keywords,
 *   sources: ['web', 'hunter', 'apollo', 'urls'], urls: ['https://...'],
 *   limit: 100, perSiteMaxEmails: 3, pages: 2
 * }
 */
async function runSearch(searchId, params) {
  const limit = Math.min(Number(params.limit) || 100, 1000);
  const perSite = Number(params.perSiteMaxEmails) || 3;
  const sources = params.sources?.length ? params.sources : ['web'];
  const countries = params.countries?.length ? params.countries : [''];
  const industries = params.industries?.length ? params.industries : [''];
  const errors = [];
  const seenDomains = new Set();
  let count = 0;

  const collect = async (site, meta) => {
    if (count >= limit || seenDomains.has(site.domain)) return;
    seenDomains.add(site.domain);
    const base = { company: site.company || '', website: site.website, country: meta.country ? countryName(meta.country) : '', industry: meta.industry || '' };

    if (sources.includes('hunter') && db.getSetting('hunter_api_key')) {
      try {
        const found = await deps.providers.hunterDomainSearch(site.domain, { limit: perSite });
        for (const e of found.emails.slice(0, perSite)) {
          if (count >= limit) break;
          if (saveLead(searchId, { ...base, ...e, company: base.company || found.company, source: 'hunter' })) count++;
        }
        if (found.emails.length) return;
      } catch (err) {
        errors.push(err.message);
      }
    }
    // Fall back to crawling the company's own website.
    {
      try {
        const site2 = await deps.crawler.crawlSite(site.website);
        for (const e of site2.emails.slice(0, perSite)) {
          if (count >= limit) break;
          if (saveLead(searchId, { ...base, company: base.company || site2.company, email: e.email, source_url: e.source_url, source: meta.source })) count++;
        }
      } catch (err) {
        errors.push(`${site.website}: ${err.message}`);
      }
    }
    progress(searchId, `Checked ${seenDomains.size} websites, found ${count} emails`);
  };

  try {
    // 1) User supplied URLs / domains.
    if (sources.includes('urls')) {
      for (const raw of params.urls || []) {
        const url = /^https?:\/\//i.test(raw) ? raw.trim() : `https://${raw.trim()}`;
        if (!raw.trim()) continue;
        await collect({ website: new URL(url).origin, domain: search.hostOf(url) }, { source: 'crawl', country: countries[0], industry: industries[0] });
      }
    }

    // 2) Country x industry discovery.
    for (const country of countries) {
      for (const industry of industries) {
        if (count >= limit) break;
        if (!country && !industry && !params.keywords) continue;
        const meta = { country, industry };
        const label = [industry, country && countryName(country)].filter(Boolean).join(' / ');
        let sites = [];

        if (sources.includes('hunter') && db.getSetting('hunter_api_key')) {
          progress(searchId, `Hunter.io discover: ${label}`);
          try {
            sites.push(...(await deps.providers.hunterDiscover({ country, industry, keywords: params.keywords })).map((s) => ({ ...s, source: 'hunter' })));
          } catch (err) {
            errors.push(err.message);
          }
        }
        if (sources.includes('apollo') && db.getSetting('apollo_api_key')) {
          progress(searchId, `Apollo.io search: ${label}`);
          try {
            sites.push(...(await deps.providers.apolloCompanies({ country, industry, keywords: params.keywords })).map((s) => ({ ...s, source: 'apollo' })));
          } catch (err) {
            errors.push(err.message);
          }
        }
        if (sources.includes('web')) {
          progress(searchId, `Web search: ${label}`);
          try {
            const r = await deps.search.searchCompanies({ country, industry, keywords: params.keywords, pages: params.pages || 2 });
            sites.push(...r.sites.map((s) => ({ ...s, source: `web:${r.engine}` })));
          } catch (err) {
            errors.push(err.message);
          }
        }

        for (const site of sites) {
          if (count >= limit) break;
          await collect(site, { ...meta, source: site.source });
        }
      }
    }

    const total = progress(searchId, `Done - checked ${seenDomains.size} websites`);
    db.run(
      "UPDATE lead_searches SET status = 'done', finished_at = ?, results_count = ?, error = ? WHERE id = ?",
      db.now(), total, errors.length ? [...new Set(errors)].slice(0, 20).join('\n') : null, searchId,
    );
  } catch (err) {
    db.run("UPDATE lead_searches SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", db.now(), String(err.message || err), searchId);
  }
}

module.exports = { createSearch, runSearch, saveLead, deps };
