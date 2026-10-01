/*
 * Lead Finder: discover companies by country + industry (web search, Hunter.io,
 * Apollo.io or user-supplied URLs), then collect publicly listed business
 * emails (Hunter domain search or a polite, robots.txt-aware crawl).
 *
 * Searches run incrementally across scheduler ticks; progress is stored on
 * the leadSearches/{id} document and results in leadSearches/{id}/leads.
 */
var Leads = (function () {
  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  const JUNK_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$|^(no-?reply|donotreply|mailer-daemon|postmaster)@|@(example|domain|email|yourdomain|yoursite|sentry|wixpress|sentry-next)\.|@[0-9.]+$|^[0-9a-f]{16,}@/i;
  const CONTACT_HINTS = /contact|about|team|people|staff|enquir|inquir|reach|get-in-touch|hubungi|kontak|lianxi|联系|关于/i;
  const SKIP_HOSTS = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|wikipedia|reddit|quora|medium|amazon|ebay|glassdoor|indeed|jobstreet|crunchbase|bloomberg|google|bing|duckduckgo|yelp|tripadvisor|apple|microsoft|github)\.[a-z.]+$/i;

  // ------------------------------------------------------------ pure helpers
  function decodeEntities(s) {
    return String(s)
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&commat;/g, '@').replace(/&period;/g, '.').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }

  function decodeCfEmail(hex) {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  }

  function cleanEmail(e) {
    let email;
    try {
      email = decodeURIComponent(String(e));
    } catch (err) {
      email = String(e);
    }
    email = email.trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return null;
    if (JUNK_RE.test(email)) return null;
    return email;
  }

  function extractEmails(html) {
    const found = [];
    const add = function (e) {
      const c = cleanEmail(e);
      if (c && found.indexOf(c) < 0) found.push(c);
    };
    let m;
    const mailto = /href\s*=\s*["']\s*mailto:([^"'?]+)/gi;
    while ((m = mailto.exec(html))) add(decodeEntities(m[1]));
    const cf = /data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi;
    while ((m = cf.exec(html))) add(decodeCfEmail(m[1]));
    const text = decodeEntities(String(html)
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '))
      .replace(/\s*(\[at\]|\(at\))\s*/gi, '@')
      .replace(/\s*(\[dot\]|\(dot\))\s*/gi, '.');
    (text.match(EMAIL_RE) || []).forEach(add);
    return found;
  }

  function siteName(html, url) {
    const og = String(html).match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
    const title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const name = decodeEntities((og && og[1]) || (title && title[1]) || '').split(/\s[|\-–—:]\s/)[0].trim();
    return name.slice(0, 120) || hostOf(url);
  }

  function hostOf(url) {
    const m = String(url).match(/^https?:\/\/([^/?#:]+)/i);
    return m ? m[1].replace(/^www\./, '').toLowerCase() : '';
  }
  function originOf(url) {
    const m = String(url).match(/^(https?:\/\/[^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function pathOf(url) {
    const m = String(url).match(/^https?:\/\/[^/?#]+([^#]*)/i);
    return (m && m[1]) || '/';
  }
  function resolve(href, base) {
    href = decodeEntities(String(href).trim());
    if (/^https?:\/\//i.test(href)) return href;
    if (/^\/\//.test(href)) return base.split(':')[0] + ':' + href;
    if (/^(mailto|tel|javascript|#)/i.test(href)) return null;
    const origin = originOf(base);
    if (href.charAt(0) === '/') return origin + href;
    const dir = base.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
    return (/^https?:\/\/[^/]+$/i.test(dir) ? dir + '/' : dir) + href;
  }

  function contactLinks(html, base) {
    const origin = originOf(base);
    const out = [];
    const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (!CONTACT_HINTS.test(m[1] + ' ' + m[2].replace(/<[^>]+>/g, ''))) continue;
      const u = resolve(m[1], base);
      if (u && originOf(u) === origin) {
        const clean = u.replace(/#.*$/, '');
        if (out.indexOf(clean) < 0) out.push(clean);
      }
    }
    return out;
  }

  function parseRobots(txt, agent) {
    agent = String(agent || '').split('/')[0].toLowerCase();
    const rules = [];
    let applies = false;
    let sawRule = false;
    String(txt).split(/\r?\n/).forEach(function (raw) {
      const line = raw.replace(/#.*/, '').trim();
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) return;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'user-agent') {
        if (sawRule) {
          applies = false;
          sawRule = false;
        }
        if (val === '*' || (val && agent.indexOf(val.toLowerCase()) >= 0)) applies = true;
      } else if (key === 'disallow' || key === 'allow') {
        sawRule = true;
        if (applies && val) rules.push({ allow: key === 'allow', path: val });
      }
    });
    return rules;
  }

  function pathAllowed(rules, path) {
    let best = null;
    rules.forEach(function (r) {
      const pattern = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (pattern.test(path) && (!best || r.path.length > best.path.length)) best = r;
    });
    return !best || best.allow;
  }

  function uniqueSites(urls) {
    const seen = {};
    const out = [];
    urls.forEach(function (url) {
      const host = hostOf(url);
      if (!host || SKIP_HOSTS.test(host) || seen[host]) return;
      seen[host] = true;
      out.push({ website: originOf(url), domain: host });
    });
    return out;
  }

  // ------------------------------------------------------------ network
  function ua() {
    return CONFIG.settings().crawler_user_agent || 'EmailingLeadFinder/1.0';
  }

  function request(url) {
    return { url: url, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': ua() } };
  }

  function textOf(res) {
    if (!res || res.getResponseCode() !== 200) return null;
    const type = String((res.getHeaders() || {})['Content-Type'] || (res.getHeaders() || {})['content-type'] || '');
    if (type && !/text|html|xml/i.test(type)) return null;
    return res.getContentText().slice(0, 1500000);
  }

  function fetchMany(urls) {
    try {
      return UrlFetchApp.fetchAll(urls.map(request)).map(textOf);
    } catch (e) {
      return urls.map(function (u) {
        try {
          return textOf(UrlFetchApp.fetch(u, request(u)));
        } catch (err) {
          return null;
        }
      });
    }
  }

  /** Crawl a company website. Returns { company, website, emails: [{email, source_url}] }. */
  function crawlSite(startUrl, maxPages) {
    maxPages = maxPages || 6;
    const url = /^https?:\/\//i.test(startUrl) ? startUrl : 'https://' + startUrl;
    const origin = originOf(url);
    const rules = parseRobots(fetchMany([origin + '/robots.txt'])[0] || '', ua());
    const visited = {};
    const emails = {};
    let company = '';
    const crawl = function (pages) {
      const allowed = pages.filter(function (p) {
        const key = p.replace(/\/+$/, '');
        if (visited[key] || !pathAllowed(rules, pathOf(p))) return false;
        visited[key] = true;
        return true;
      }).slice(0, maxPages);
      const bodies = fetchMany(allowed);
      return allowed.map(function (p, i) { return { url: p, html: bodies[i] }; }).filter(function (r) { return r.html; });
    };
    const first = crawl([url, origin + '/contact', origin + '/contact-us', origin + '/about']);
    let extra = [];
    first.forEach(function (page) {
      if (!company) company = siteName(page.html, page.url);
      if (page.url === url) extra = contactLinks(page.html, page.url);
    });
    const more = crawl(extra.slice(0, Math.max(0, maxPages - 4)));
    first.concat(more).forEach(function (page) {
      extractEmails(page.html).forEach(function (e) {
        if (!emails[e]) emails[e] = page.url;
      });
    });
    const host = hostOf(origin);
    const list = Object.keys(emails).map(function (e) { return { email: e, source_url: emails[e] }; });
    list.sort(function (a, b) { return Number(b.email.slice(-host.length) === host) - Number(a.email.slice(-host.length) === host); });
    return { company: company || host, website: origin, emails: list };
  }

  function buildQuery(country, industry, keywords) {
    return [industry && '"' + industry + '"', keywords, 'company', country && EmailCatalog.countryName(country), 'contact email'].filter(Boolean).join(' ');
  }

  function duckDuckGo(query, country, pages) {
    const c = EmailCatalog.byCode(country);
    const links = [];
    let form = { q: query, kl: c ? c.region : 'wt-wt' };
    for (let p = 0; p < pages; p++) {
      const res = UrlFetchApp.fetch('https://html.duckduckgo.com/html/', {
        method: 'post', payload: form, muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmailingLeadFinder/1.0)' },
      });
      if (res.getResponseCode() !== 200) throw new Error('DuckDuckGo responded ' + res.getResponseCode());
      const html = res.getContentText();
      const tagRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/gi;
      let m;
      while ((m = tagRe.exec(html))) {
        const href = (m[0].match(/href="([^"]+)"/) || [])[1];
        if (!href) continue;
        const h = decodeEntities(href);
        const uddg = h.match(/[?&]uddg=([^&]+)/);
        links.push(uddg ? decodeURIComponent(uddg[1]) : h.replace(/^\/\//, 'https://'));
      }
      const next = html.match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*value="Next"(?:(?!<\/form>)[\s\S])*<\/form>/i);
      if (!next) break;
      form = {};
      const inRe = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
      while ((m = inRe.exec(next[0]))) form[m[1]] = decodeEntities(m[2]);
      Utilities.sleep(1200);
    }
    return links;
  }

  function googleCse(query, country, pages) {
    const sec = CONFIG.secrets();
    const links = [];
    for (let p = 0; p < pages; p++) {
      let url = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(sec.google_cse_key) + '&cx=' + encodeURIComponent(sec.google_cse_cx) +
        '&num=10&start=' + (p * 10 + 1) + '&q=' + encodeURIComponent(query);
      if (country) url += '&gl=' + String(country).toLowerCase();
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('Google Custom Search responded ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
      const data = JSON.parse(res.getContentText());
      (data.items || []).forEach(function (i) { links.push(i.link); });
      if (!data.queries || !data.queries.nextPage) break;
    }
    return links;
  }

  function webSearch(country, industry, keywords, pages) {
    const sec = CONFIG.secrets();
    const q = buildQuery(country, industry, keywords);
    const useGoogle = sec.google_cse_key && sec.google_cse_cx;
    const links = useGoogle ? googleCse(q, country, pages) : duckDuckGo(q, country, pages);
    return uniqueSites(links).map(function (s) { s.source = useGoogle ? 'web:google' : 'web:duckduckgo'; return s; });
  }

  function apiJson(res, name) {
    const text = res.getContentText();
    let body = {};
    try { body = JSON.parse(text); } catch (e) { /* not json */ }
    if (res.getResponseCode() >= 300) {
      const detail = (body.errors && body.errors[0] && body.errors[0].details) || body.error || body.message || text.slice(0, 200);
      throw new Error(name + ' API error ' + res.getResponseCode() + ': ' + detail);
    }
    return body;
  }

  function hunterDiscover(country, industry, keywords) {
    const key = CONFIG.secrets().hunter_api_key;
    const body = { query: [industry, keywords, 'companies', country && 'in ' + EmailCatalog.countryName(country)].filter(Boolean).join(' '), limit: 25 };
    if (country) body.headquarters_location = { include: [{ country: String(country).toUpperCase() }] };
    const res = UrlFetchApp.fetch('https://api.hunter.io/v2/discover?api_key=' + encodeURIComponent(key), {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    return (apiJson(res, 'Hunter').data || []).filter(function (c) { return c.domain; }).map(function (c) {
      return { website: 'https://' + c.domain, domain: c.domain, company: c.organization || '', source: 'hunter' };
    });
  }

  function hunterDomain(domain, limit) {
    const key = CONFIG.secrets().hunter_api_key;
    const res = UrlFetchApp.fetch('https://api.hunter.io/v2/domain-search?domain=' + encodeURIComponent(domain) + '&limit=' + limit + '&api_key=' + encodeURIComponent(key), { muteHttpExceptions: true });
    const data = apiJson(res, 'Hunter').data || {};
    return {
      company: data.organization || '',
      emails: (data.emails || []).map(function (e) {
        return { email: e.value, first_name: e.first_name || '', last_name: e.last_name || '', position: e.position || '', source_url: 'hunter.io:' + domain };
      }),
    };
  }

  function apolloCompanies(country, industry, keywords) {
    const key = CONFIG.secrets().apollo_api_key;
    const tags = [industry, keywords].filter(Boolean);
    const body = { page: 1, per_page: 25 };
    if (country) body.organization_locations = [EmailCatalog.countryName(country)];
    if (tags.length) body.q_organization_keyword_tags = tags;
    const res = UrlFetchApp.fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'cache-control': 'no-cache' },
    });
    const data = apiJson(res, 'Apollo');
    return (data.organizations || []).concat(data.accounts || []).map(function (o) {
      const domain = o.primary_domain || hostOf(o.website_url || '');
      return domain ? { website: o.website_url || 'https://' + domain, domain: domain, company: o.name || '', source: 'apollo' } : null;
    }).filter(Boolean);
  }

  // ------------------------------------------------------------ orchestration
  function saveLead(searchId, lead) {
    const email = cleanEmail(lead.email);
    if (!email) return false;
    return !!FS.create('leadSearches/' + searchId + '/leads', {
      email: email, first_name: lead.first_name || '', last_name: lead.last_name || '', position: lead.position || '',
      company: lead.company || '', website: lead.website || '', country: lead.country || '', industry: lead.industry || '',
      source: lead.source || '', source_url: lead.source_url || '', imported: false, created_at: nowIso(),
    }, email);
  }

  function initState(p) {
    const combos = [];
    const countries = p.countries && p.countries.length ? p.countries : [''];
    const industries = p.industries && p.industries.length ? p.industries : [''];
    countries.forEach(function (c) {
      industries.forEach(function (i) {
        if (c || i || p.keywords) combos.push({ country: c, industry: i }); // objects: Firestore cannot store nested arrays
      });
    });
    const sites = [];
    if ((p.sources || []).indexOf('urls') >= 0) {
      (p.urls || []).forEach(function (u) {
        u = String(u).trim();
        if (!u) return;
        const url = /^https?:\/\//i.test(u) ? u : 'https://' + u;
        sites.push({ website: originOf(url), domain: hostOf(url), source: 'crawl', country: countries[0] || '', industry: industries[0] || '' });
      });
    }
    return { combos: combos, comboIndex: 0, sites: sites, siteIndex: 0, count: 0, errors: [] };
  }

  /** Advance the oldest pending lead search while time remains. */
  function process(hasTime) {
    const pending = FS.query('leadSearches', { where: [['status', '==', 'running']], limit: 1 })
      .concat(FS.query('leadSearches', { where: [['status', '==', 'queued']], limit: 1 }));
    if (!pending.length) return 0;
    const search = pending[0];
    const p = search.params || {};
    const st = search.state && search.state.combos ? search.state : initState(p);
    const sources = p.sources && p.sources.length ? p.sources : ['web'];
    const limit = Math.min(Number(p.limit) || 100, 1000);
    const perSite = Number(p.perSiteMaxEmails) || 3;
    const sec = CONFIG.secrets();
    const seen = {};
    st.sites.forEach(function (s) { seen[s.domain] = true; });
    const save = function (fields) {
      st.errors = st.errors.filter(function (e, i) { return st.errors.indexOf(e) === i; }).slice(-20);
      FS.update('leadSearches/' + search.id, Object.assign({
        status: 'running', state: st, results_count: st.count,
        progress: 'Checked ' + st.siteIndex + ' of ' + st.sites.length + ' websites, found ' + st.count + ' emails',
        error: st.errors.join('\n') || null,
      }, fields || {}));
    };
    const addSites = function (list, meta) {
      list.forEach(function (s) {
        if (!s.domain || seen[s.domain]) return;
        seen[s.domain] = true;
        st.sites.push(Object.assign({ country: meta.country, industry: meta.industry }, s));
      });
    };

    try {
      // 1) Discover company websites for each country x industry.
      while (st.comboIndex < st.combos.length && hasTime()) {
        const combo = st.combos[st.comboIndex];
        if (sources.indexOf('hunter') >= 0 && sec.hunter_api_key) {
          try { addSites(hunterDiscover(combo.country, combo.industry, p.keywords), combo); } catch (e) { st.errors.push(e.message); }
        }
        if (sources.indexOf('apollo') >= 0 && sec.apollo_api_key) {
          try { addSites(apolloCompanies(combo.country, combo.industry, p.keywords), combo); } catch (e) { st.errors.push(e.message); }
        }
        if (sources.indexOf('web') >= 0) {
          try { addSites(webSearch(combo.country, combo.industry, p.keywords, Math.min(Number(p.pages) || 2, 5)), combo); } catch (e) { st.errors.push(e.message); }
        }
        st.comboIndex++;
        save();
      }
      // 2) Collect emails per website.
      while (st.comboIndex >= st.combos.length && st.siteIndex < st.sites.length && st.count < limit && hasTime()) {
        const site = st.sites[st.siteIndex];
        const base = { company: site.company || '', website: site.website, country: site.country ? EmailCatalog.countryName(site.country) : '', industry: site.industry || '' };
        let found = [];
        if (sources.indexOf('hunter') >= 0 && sec.hunter_api_key) {
          try {
            const h = hunterDomain(site.domain, perSite);
            base.company = base.company || h.company;
            found = h.emails.map(function (e) { return Object.assign({}, base, e, { source: 'hunter' }); });
          } catch (e) { st.errors.push(e.message); }
        }
        if (!found.length) {
          try {
            const r = crawlSite(site.website);
            base.company = base.company || r.company;
            found = r.emails.map(function (e) { return Object.assign({}, base, e, { source: site.source || 'crawl' }); });
          } catch (e) { st.errors.push(site.website + ': ' + e.message); }
        }
        found.slice(0, perSite).forEach(function (lead) {
          if (st.count < limit && saveLead(search.id, lead)) st.count++;
        });
        st.siteIndex++;
        save();
      }
      const done = st.comboIndex >= st.combos.length && (st.siteIndex >= st.sites.length || st.count >= limit);
      if (done) save({ status: 'done', finished_at: nowIso(), progress: 'Done - checked ' + st.siteIndex + ' websites, found ' + st.count + ' emails' });
    } catch (e) {
      save({ status: 'failed', finished_at: nowIso(), error: String(e.message || e) });
    }
    return 1;
  }

  return {
    process: process, crawlSite: crawlSite, extractEmails: extractEmails, parseRobots: parseRobots, pathAllowed: pathAllowed,
    contactLinks: contactLinks, uniqueSites: uniqueSites, siteName: siteName, cleanEmail: cleanEmail, decodeCfEmail: decodeCfEmail,
  };
})();
