/*
 * Online search for company websites by country + industry.
 * Uses Google Programmable Search (if configured) or DuckDuckGo's HTML
 * endpoint (no key needed), plus optional B2B data portals.
 */
const cheerio = require('cheerio');
const db = require('../../db');
const { byCode, countryName } = require('./countries');

// Big platforms / directories whose pages are not a company's own website.
const SKIP_HOSTS = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|wikipedia|reddit|quora|medium|amazon|ebay|glassdoor|indeed|jobstreet|crunchbase|bloomberg|google|bing|duckduckgo|yelp|tripadvisor|apple|microsoft|github)\.[a-z.]+$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function uniqueSites(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || SKIP_HOSTS.test(host) || seen.has(host)) continue;
    seen.add(host);
    out.push({ website: new URL(url).origin, domain: host });
  }
  return out;
}

function buildQuery({ country, industry, keywords }) {
  return [industry && `"${industry}"`, keywords, 'company', country && countryName(country), 'contact email']
    .filter(Boolean)
    .join(' ');
}

async function duckDuckGo(query, { country, pages = 1 } = {}) {
  const region = byCode(country)?.region || 'wt-wt';
  const links = [];
  let form = { q: query, kl: region };
  for (let page = 0; page < pages; page++) {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (compatible; EmailingLeadFinder/1.0)',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`DuckDuckGo responded ${res.status}`);
    const $ = cheerio.load(await res.text());
    $('a.result__a').each((_, el) => {
      const href = $(el).attr('href') || '';
      try {
        const u = new URL(href, 'https://duckduckgo.com');
        links.push(u.searchParams.get('uddg') || u.toString());
      } catch {
        /* ignore */
      }
    });
    // "Next" page form
    const next = $('form').filter((_, f) => $(f).find('input[value="Next"]').length).first();
    if (!next.length) break;
    form = {};
    next.find('input[name]').each((_, i) => {
      form[$(i).attr('name')] = $(i).attr('value') || '';
    });
    await new Promise((r) => setTimeout(r, 1200));
  }
  return links;
}

async function googleCse(query, { country, pages = 1 } = {}) {
  const key = db.getSetting('google_cse_key');
  const cx = db.getSetting('google_cse_cx');
  const links = [];
  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({ key, cx, q: query, num: '10', start: String(page * 10 + 1) });
    if (country) params.set('gl', String(country).toLowerCase());
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Google CSE responded ${res.status}`);
    const data = await res.json();
    for (const item of data.items || []) links.push(item.link);
    if (!data.queries?.nextPage) break;
  }
  return links;
}

/** Search the web for company sites. Returns [{ website, domain }]. */
async function searchCompanies({ country, industry, keywords, pages = 2 }) {
  const query = buildQuery({ country, industry, keywords });
  const useGoogle = db.getSetting('google_cse_key') && db.getSetting('google_cse_cx');
  const links = useGoogle ? await googleCse(query, { country, pages }) : await duckDuckGo(query, { country, pages });
  return { query, engine: useGoogle ? 'google' : 'duckduckgo', sites: uniqueSites(links) };
}

module.exports = { searchCompanies, uniqueSites, buildQuery, hostOf, duckDuckGo, googleCse };
