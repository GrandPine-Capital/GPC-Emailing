/*
 * B2B data portals (API keys configured in Settings):
 *  - Hunter.io: Discover (companies by country/industry) + Domain Search (emails per domain)
 *  - Apollo.io: Organization search (companies by location/industry keywords)
 */
const db = require('../../db');
const { countryName } = require('./countries');

async function json(res, name) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.errors?.[0]?.details || body.error || body.message || res.statusText;
    throw new Error(`${name} API error ${res.status}: ${detail}`);
  }
  return body;
}

async function hunterDiscover({ country, industry, keywords, limit = 25 }) {
  const key = db.getSetting('hunter_api_key');
  if (!key) throw new Error('Hunter.io API key not configured');
  const body = {
    query: [industry, keywords, 'companies', country && `in ${countryName(country)}`].filter(Boolean).join(' '),
    limit,
  };
  if (country) body.headquarters_location = { include: [{ country: String(country).toUpperCase() }] };
  const res = await fetch(`https://api.hunter.io/v2/discover?api_key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await json(res, 'Hunter');
  return (data.data || [])
    .filter((c) => c.domain)
    .map((c) => ({ website: `https://${c.domain}`, domain: c.domain, company: c.organization || '' }));
}

async function hunterDomainSearch(domain, { limit = 10 } = {}) {
  const key = db.getSetting('hunter_api_key');
  if (!key) throw new Error('Hunter.io API key not configured');
  const params = new URLSearchParams({ domain, limit: String(limit), api_key: key });
  const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, { signal: AbortSignal.timeout(20000) });
  const data = (await json(res, 'Hunter')).data || {};
  return {
    company: data.organization || '',
    emails: (data.emails || []).map((e) => ({
      email: e.value,
      first_name: e.first_name || '',
      last_name: e.last_name || '',
      position: e.position || '',
      source_url: `hunter.io:${domain}`,
    })),
  };
}

async function apolloCompanies({ country, industry, keywords, limit = 25 }) {
  const key = db.getSetting('apollo_api_key');
  if (!key) throw new Error('Apollo.io API key not configured');
  const tags = [industry, keywords].filter(Boolean);
  const res = await fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': key },
    body: JSON.stringify({
      organization_locations: country ? [countryName(country)] : undefined,
      q_organization_keyword_tags: tags.length ? tags : undefined,
      page: 1,
      per_page: Math.min(100, limit),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await json(res, 'Apollo');
  return [...(data.organizations || []), ...(data.accounts || [])]
    .map((o) => {
      const domain = o.primary_domain || (o.website_url ? new URL(o.website_url).hostname.replace(/^www\./, '') : '');
      return domain ? { website: o.website_url || `https://${domain}`, domain, company: o.name || '' } : null;
    })
    .filter(Boolean);
}

module.exports = { hunterDiscover, hunterDomainSearch, apolloCompanies };
