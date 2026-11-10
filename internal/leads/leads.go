// Package leads finds companies by country and industry (web search, Hunter.io, Apollo.io or
// given URLs) and collects publicly listed business e-mail addresses (Hunter's domain search,
// or a polite, robots.txt-aware crawl of the company's website). Port of Leads.js.
package leads

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/catalog"
)

var (
	emailRe      = regexp.MustCompile(`(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}`)
	strictRe     = regexp.MustCompile(`^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$`)
	junkRe       = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$|^(no-?reply|donotreply|mailer-daemon|postmaster)@|@(example|domain|email|yourdomain|yoursite|sentry|wixpress|sentry-next)\.|@[0-9.]+$|^[0-9a-f]{16,}@`)
	contactHints = regexp.MustCompile(`(?i)contact|about|team|people|staff|enquir|inquir|reach|get-in-touch|hubungi|kontak|lianxi|联系|关于`)
	skipHosts    = regexp.MustCompile(`(?i)(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|wikipedia|reddit|quora|medium|amazon|ebay|glassdoor|indeed|jobstreet|crunchbase|bloomberg|google|bing|duckduckgo|yelp|tripadvisor|apple|microsoft|github)\.[a-z.]+$`)
)

// ------------------------------------------------------------ pure helpers

var (
	decRe = regexp.MustCompile(`&#(\d+);`)
	hexRe = regexp.MustCompile(`(?i)&#x([0-9a-f]+);`)
)

func decodeEntities(s string) string {
	s = decRe.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.Atoi(decRe.FindStringSubmatch(m)[1])
		return string(rune(n))
	})
	s = hexRe.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseInt(hexRe.FindStringSubmatch(m)[1], 16, 32)
		return string(rune(n))
	})
	return strings.NewReplacer("&commat;", "@", "&period;", ".", "&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`).Replace(s)
}

// DecodeCfEmail decodes Cloudflare's e-mail obfuscation (data-cfemail).
func DecodeCfEmail(h string) string {
	b, err := hex.DecodeString(h)
	if err != nil || len(b) < 2 {
		return ""
	}
	out := make([]byte, len(b)-1)
	for i := 1; i < len(b); i++ {
		out[i-1] = b[i] ^ b[0]
	}
	return string(out)
}

var trailingPunct = regexp.MustCompile(`[.,;:]+$`)

// CleanEmail normalises a found address, or "" when it is junk.
func CleanEmail(e string) string {
	if d, err := url.QueryUnescape(e); err == nil {
		e = d
	}
	e = strings.TrimSpace(e)
	if len(e) >= 7 && strings.EqualFold(e[:7], "mailto:") {
		e = e[7:]
	}
	e, _, _ = strings.Cut(e, "?")
	e = strings.ToLower(trailingPunct.ReplaceAllString(e, ""))
	if !strictRe.MatchString(e) || junkRe.MatchString(e) {
		return ""
	}
	return e
}

var (
	mailtoRe = regexp.MustCompile(`(?i)href\s*=\s*["']\s*mailto:([^"'?]+)`)
	cfRe     = regexp.MustCompile(`(?i)data-cfemail\s*=\s*["']([0-9a-f]+)["']`)
	scriptRe = regexp.MustCompile(`(?is)<(script|style|noscript)[\s>].*?</(script|style|noscript)>`)
	tagRe    = regexp.MustCompile(`<[^>]+>`)
	atRe     = regexp.MustCompile(`(?i)\s*(\[at\]|\(at\))\s*`)
	dotRe    = regexp.MustCompile(`(?i)\s*(\[dot\]|\(dot\))\s*`)
)

// ExtractEmails finds addresses in a page: mailto links, Cloudflare-protected ones and text
// (including "name [at] domain [dot] com").
func ExtractEmails(page string) []string {
	var found []string
	add := func(e string) {
		if c := CleanEmail(e); c != "" && !contains(found, c) {
			found = append(found, c)
		}
	}
	for _, m := range mailtoRe.FindAllStringSubmatch(page, -1) {
		add(decodeEntities(m[1]))
	}
	for _, m := range cfRe.FindAllStringSubmatch(page, -1) {
		add(DecodeCfEmail(m[1]))
	}
	text := decodeEntities(tagRe.ReplaceAllString(scriptRe.ReplaceAllString(page, " "), " "))
	text = dotRe.ReplaceAllString(atRe.ReplaceAllString(text, "@"), ".")
	for _, e := range emailRe.FindAllString(text, -1) {
		add(e)
	}
	return found
}

var (
	ogRe     = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']`)
	titleRe  = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	titleSep = regexp.MustCompile(`\s[|\-–—:]\s`)
)

// SiteName is the company name from og:site_name or the page title.
func SiteName(page, pageURL string) string {
	name := ""
	if m := ogRe.FindStringSubmatch(page); m != nil {
		name = m[1]
	} else if m := titleRe.FindStringSubmatch(page); m != nil {
		name = m[1]
	}
	name = strings.TrimSpace(titleSep.Split(decodeEntities(name), 2)[0])
	if len([]rune(name)) > 120 {
		name = string([]rune(name)[:120])
	}
	if name == "" {
		return HostOf(pageURL)
	}
	return name
}

var (
	hostRe   = regexp.MustCompile(`(?i)^https?://([^/?#:]+)`)
	originRe = regexp.MustCompile(`(?i)^(https?://[^/?#]+)`)
	pathRe   = regexp.MustCompile(`(?i)^https?://[^/?#]+([^#]*)`)
)

func HostOf(u string) string {
	m := hostRe.FindStringSubmatch(u)
	if m == nil {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(m[1]), "www.")
}

func OriginOf(u string) string {
	if m := originRe.FindStringSubmatch(u); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

func pathOf(u string) string {
	if m := pathRe.FindStringSubmatch(u); m != nil && m[1] != "" {
		return m[1]
	}
	return "/"
}

func resolve(href, base string) string {
	href = strings.TrimSpace(decodeEntities(href))
	lower := strings.ToLower(href)
	switch {
	case strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://"):
		return href
	case strings.HasPrefix(href, "//"):
		scheme, _, _ := strings.Cut(base, ":")
		return scheme + ":" + href
	case strings.HasPrefix(lower, "mailto") || strings.HasPrefix(lower, "tel") || strings.HasPrefix(lower, "javascript") || strings.HasPrefix(href, "#"):
		return ""
	}
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	r, err := b.Parse(href)
	if err != nil {
		return ""
	}
	return r.String()
}

var anchorRe = regexp.MustCompile(`(?is)<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>`)

// ContactLinks are same-site links that look like contact or about pages.
func ContactLinks(page, base string) []string {
	origin := OriginOf(base)
	var out []string
	for _, m := range anchorRe.FindAllStringSubmatch(page, -1) {
		if !contactHints.MatchString(m[1] + " " + tagRe.ReplaceAllString(m[2], "")) {
			continue
		}
		if u := resolve(m[1], base); u != "" && OriginOf(u) == origin {
			clean, _, _ := strings.Cut(u, "#")
			if !contains(out, clean) {
				out = append(out, clean)
			}
		}
	}
	return out
}

type robotsRule struct {
	allow bool
	path  string
}

var robotsLineRe = regexp.MustCompile(`(?i)^([a-z-]+)\s*:\s*(.*)$`)

// ParseRobots returns the robots.txt rules that apply to the user agent.
func ParseRobots(txt, agent string) []robotsRule {
	agent, _, _ = strings.Cut(strings.ToLower(agent), "/")
	var rules []robotsRule
	applies, sawRule := false, false
	for _, raw := range strings.Split(strings.ReplaceAll(txt, "\r\n", "\n"), "\n") {
		line, _, _ := strings.Cut(raw, "#")
		m := robotsLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		key, val := strings.ToLower(m[1]), strings.TrimSpace(m[2])
		switch key {
		case "user-agent":
			if sawRule {
				applies, sawRule = false, false
			}
			if val == "*" || (val != "" && strings.Contains(agent, strings.ToLower(val))) {
				applies = true
			}
		case "disallow", "allow":
			sawRule = true
			if applies && val != "" {
				rules = append(rules, robotsRule{allow: key == "allow", path: val})
			}
		}
	}
	return rules
}

// PathAllowed applies the longest matching rule.
func PathAllowed(rules []robotsRule, path string) bool {
	var best *robotsRule
	for i, r := range rules {
		p := regexp.QuoteMeta(r.path)
		p = strings.ReplaceAll(p, `\*`, ".*")
		if strings.HasSuffix(p, `\$`) {
			p = strings.TrimSuffix(p, `\$`) + "$"
		}
		re, err := regexp.Compile("^" + p)
		if err != nil {
			continue
		}
		if re.MatchString(path) && (best == nil || len(r.path) > len(best.path)) {
			best = &rules[i]
		}
	}
	return best == nil || best.allow
}

// Site is a company website to collect addresses from.
type Site struct {
	Website  string `json:"website"`
	Domain   string `json:"domain"`
	Company  string `json:"company,omitempty"`
	Source   string `json:"source,omitempty"`
	Country  string `json:"country,omitempty"`
	Industry string `json:"industry,omitempty"`
}

// UniqueSites keeps one site per host, skipping social networks and directories.
func UniqueSites(urls []string) []Site {
	seen := map[string]bool{}
	var out []Site
	for _, u := range urls {
		host := HostOf(u)
		if host == "" || skipHosts.MatchString(host) || seen[host] {
			continue
		}
		seen[host] = true
		out = append(out, Site{Website: OriginOf(u), Domain: host})
	}
	return out
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------ network

// Finder does the network work. Client must refuse private addresses (app.SafeClient).
type Finder struct {
	Client    *http.Client
	UserAgent string
	Secrets   map[string]string
	// Sleep pauses between search pages (tests make it a no-op).
	Sleep func(time.Duration)
	// Endpoints, overridable in tests.
	DuckDuckGoURL, GoogleCSEURL, HunterURL, ApolloURL string
}

func (f *Finder) ua() string {
	if f.UserAgent != "" {
		return f.UserAgent
	}
	return "EmailingLeadFinder/1.0"
}

func (f *Finder) sleep(d time.Duration) {
	if f.Sleep != nil {
		f.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (f *Finder) endpoint(override, def string) string {
	if override != "" {
		return override
	}
	return def
}

func (f *Finder) fetchText(ctx context.Context, u string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", f.ua())
	res, err := f.Client.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	if ct := res.Header.Get("Content-Type"); ct != "" && !regexp.MustCompile(`(?i)text|html|xml`).MatchString(ct) {
		return ""
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1_500_000))
	return string(b)
}

func (f *Finder) fetchMany(ctx context.Context, urls []string) []string {
	out := make([]string, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = f.fetchText(ctx, u)
		}()
	}
	wg.Wait()
	return out
}

// Found is an address found on a site.
type Found struct {
	Email     string `json:"email"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
	Position  string `json:"position,omitempty"`
	SourceURL string `json:"source_url"`
}

// CrawlSite reads the home, contact and about pages (as robots.txt allows) for addresses; those
// on the site's own domain come first.
func (f *Finder) CrawlSite(ctx context.Context, start string, maxPages int) (company, website string, emails []Found) {
	if maxPages <= 0 {
		maxPages = 6
	}
	u := start
	if !regexp.MustCompile(`(?i)^https?://`).MatchString(u) {
		u = "https://" + u
	}
	origin := OriginOf(u)
	rules := ParseRobots(f.fetchMany(ctx, []string{origin + "/robots.txt"})[0], f.ua())
	visited := map[string]bool{}
	type page struct{ url, html string }
	crawl := func(pages []string) []page {
		var allowed []string
		for _, p := range pages {
			key := strings.TrimRight(p, "/")
			if visited[key] || !PathAllowed(rules, pathOf(p)) {
				continue
			}
			visited[key] = true
			allowed = append(allowed, p)
			if len(allowed) >= maxPages {
				break
			}
		}
		bodies := f.fetchMany(ctx, allowed)
		var out []page
		for i, p := range allowed {
			if bodies[i] != "" {
				out = append(out, page{p, bodies[i]})
			}
		}
		return out
	}
	first := crawl([]string{u, origin + "/contact", origin + "/contact-us", origin + "/about"})
	var extra []string
	for _, p := range first {
		if company == "" {
			company = SiteName(p.html, p.url)
		}
		if p.url == u {
			extra = ContactLinks(p.html, p.url)
		}
	}
	if n := max(0, maxPages-4); len(extra) > n {
		extra = extra[:n]
	}
	more := crawl(extra)
	seen := map[string]bool{}
	for _, p := range append(first, more...) {
		for _, e := range ExtractEmails(p.html) {
			if !seen[e] {
				seen[e] = true
				emails = append(emails, Found{Email: e, SourceURL: p.url})
			}
		}
	}
	host := HostOf(origin)
	sort.SliceStable(emails, func(i, j int) bool {
		return strings.HasSuffix(emails[i].Email, host) && !strings.HasSuffix(emails[j].Email, host)
	})
	if company == "" {
		company = host
	}
	return company, origin, emails
}

// BuildQuery is one search, e.g. `"dental laboratory" company Malaysia contact email`.
func BuildQuery(country, phrase, keywords string) string {
	parts := []string{}
	if phrase != "" {
		parts = append(parts, `"`+phrase+`"`)
	}
	if keywords != "" {
		parts = append(parts, keywords)
	}
	parts = append(parts, "company")
	if country != "" {
		parts = append(parts, catalog.CountryName(country))
	}
	return strings.Join(append(parts, "contact email"), " ")
}

var (
	ddgLinkRe  = regexp.MustCompile(`(?i)<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>`)
	ddgHrefRe  = regexp.MustCompile(`href="([^"]+)"`)
	ddgUddgRe  = regexp.MustCompile(`[?&]uddg=([^&]+)`)
	ddgFormRe  = regexp.MustCompile(`(?is)<form[^>]*>.*?</form>`)
	ddgInputRe = regexp.MustCompile(`(?i)<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"`)
)

func (f *Finder) duckDuckGo(ctx context.Context, query, country string, pages int) ([]string, error) {
	region := "wt-wt"
	if c := catalog.ByCode(country); c != nil {
		region = c.Region
	}
	form := url.Values{"q": {query}, "kl": {region}}
	var links []string
	for p := 0; p < pages; p++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.endpoint(f.DuckDuckGoURL, "https://html.duckduckgo.com/html/"), strings.NewReader(form.Encode()))
		if err != nil {
			return links, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; EmailingLeadFinder/1.0)")
		res, err := f.Client.Do(req)
		if err != nil {
			return links, err
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 3<<20))
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return links, fmt.Errorf("DuckDuckGo responded %d", res.StatusCode)
		}
		page := string(b)
		for _, tag := range ddgLinkRe.FindAllString(page, -1) {
			m := ddgHrefRe.FindStringSubmatch(tag)
			if m == nil {
				continue
			}
			h := decodeEntities(m[1])
			if u := ddgUddgRe.FindStringSubmatch(h); u != nil {
				if d, err := url.QueryUnescape(u[1]); err == nil {
					links = append(links, d)
					continue
				}
			}
			if strings.HasPrefix(h, "//") {
				h = "https:" + h
			}
			links = append(links, h)
		}
		next := ""
		for _, fm := range ddgFormRe.FindAllString(page, -1) {
			if strings.Contains(fm, `value="Next"`) {
				next = fm
				break
			}
		}
		if next == "" {
			break
		}
		form = url.Values{}
		for _, m := range ddgInputRe.FindAllStringSubmatch(next, -1) {
			form.Set(m[1], decodeEntities(m[2]))
		}
		f.sleep(1200 * time.Millisecond)
	}
	return links, nil
}

func (f *Finder) getJSON(ctx context.Context, method, u string, headers map[string]string, body any, name string, out any) error {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := f.Client.Do(req)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 5<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Errors []struct {
				Details string `json:"details"`
			} `json:"errors"`
			Error   any    `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		detail := e.Message
		if len(e.Errors) > 0 && e.Errors[0].Details != "" {
			detail = e.Errors[0].Details
		} else if e.Error != nil {
			detail = fmt.Sprint(e.Error)
		}
		if detail == "" {
			detail = strings.TrimSpace(string(data[:min(200, len(data))]))
		}
		return fmt.Errorf("%s API error %d: %s", name, res.StatusCode, detail)
	}
	return json.Unmarshal(data, out)
}

func (f *Finder) googleCSE(ctx context.Context, query, country string, pages int) ([]string, error) {
	var links []string
	for p := 0; p < pages; p++ {
		q := url.Values{"key": {f.Secrets["google_cse_key"]}, "cx": {f.Secrets["google_cse_cx"]}, "num": {"10"}, "start": {strconv.Itoa(p*10 + 1)}, "q": {query}}
		if country != "" {
			q.Set("gl", strings.ToLower(country))
		}
		var data struct {
			Items []struct {
				Link string `json:"link"`
			} `json:"items"`
			Queries struct {
				NextPage []any `json:"nextPage"`
			} `json:"queries"`
		}
		if err := f.getJSON(ctx, http.MethodGet, f.endpoint(f.GoogleCSEURL, "https://www.googleapis.com/customsearch/v1")+"?"+q.Encode(), nil, nil, "Google Custom Search", &data); err != nil {
			return links, err
		}
		for _, i := range data.Items {
			links = append(links, i.Link)
		}
		if len(data.Queries.NextPage) == 0 {
			break
		}
	}
	return links, nil
}

// WebSearch finds company sites for a country and industry; focus industries search several
// phrases for wider coverage.
func (f *Finder) WebSearch(ctx context.Context, country, industry, keywords string, pages int) ([]Site, error) {
	useGoogle := f.Secrets["google_cse_key"] != "" && f.Secrets["google_cse_cx"] != ""
	phrases := catalog.IndustryKeywords(industry)
	if len(phrases) > 4 {
		phrases = phrases[:4]
	}
	if len(phrases) == 0 {
		phrases = []string{""}
	}
	perPhrase := pages
	if len(phrases) > 1 {
		perPhrase = 1
	}
	var links []string
	var errs []error
	for i, phrase := range phrases {
		q := BuildQuery(country, phrase, keywords)
		var got []string
		var err error
		if useGoogle {
			got, err = f.googleCSE(ctx, q, country, perPhrase)
		} else {
			got, err = f.duckDuckGo(ctx, q, country, perPhrase)
		}
		links = append(links, got...)
		if err != nil {
			errs = append(errs, err)
		}
		if !useGoogle && i < len(phrases)-1 {
			f.sleep(800 * time.Millisecond)
		}
	}
	if len(links) == 0 && len(errs) > 0 {
		return nil, errs[0]
	}
	source := "web:duckduckgo"
	if useGoogle {
		source = "web:google"
	}
	sites := UniqueSites(links)
	for i := range sites {
		sites[i].Source = source
	}
	return sites, nil
}

// HunterDiscover finds companies through Hunter.io's Discover API.
func (f *Finder) HunterDiscover(ctx context.Context, country, industry, keywords string) ([]Site, error) {
	parts := []string{}
	for _, p := range []string{industry, keywords, "companies"} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if country != "" {
		parts = append(parts, "in "+catalog.CountryName(country))
	}
	body := map[string]any{"query": strings.Join(parts, " "), "limit": 25}
	if country != "" {
		body["headquarters_location"] = map[string]any{"include": []map[string]string{{"country": strings.ToUpper(country)}}}
	}
	var res struct {
		Data []struct{ Domain, Organization string } `json:"data"`
	}
	if err := f.getJSON(ctx, http.MethodPost, f.endpoint(f.HunterURL, "https://api.hunter.io/v2")+"/discover?api_key="+url.QueryEscape(f.Secrets["hunter_api_key"]), nil, body, "Hunter", &res); err != nil {
		return nil, err
	}
	var out []Site
	for _, c := range res.Data {
		if c.Domain != "" {
			out = append(out, Site{Website: "https://" + c.Domain, Domain: c.Domain, Company: c.Organization, Source: "hunter"})
		}
	}
	return out, nil
}

// HunterDomain lists a domain's addresses through Hunter.io.
func (f *Finder) HunterDomain(ctx context.Context, domain string, limit int) (string, []Found, error) {
	var res struct {
		Data struct {
			Organization string `json:"organization"`
			Emails       []struct {
				Value     string `json:"value"`
				FirstName string `json:"first_name"`
				LastName  string `json:"last_name"`
				Position  string `json:"position"`
			} `json:"emails"`
		} `json:"data"`
	}
	u := f.endpoint(f.HunterURL, "https://api.hunter.io/v2") + "/domain-search?domain=" + url.QueryEscape(domain) + "&limit=" + strconv.Itoa(limit) + "&api_key=" + url.QueryEscape(f.Secrets["hunter_api_key"])
	if err := f.getJSON(ctx, http.MethodGet, u, nil, nil, "Hunter", &res); err != nil {
		return "", nil, err
	}
	var out []Found
	for _, e := range res.Data.Emails {
		out = append(out, Found{Email: e.Value, FirstName: e.FirstName, LastName: e.LastName, Position: e.Position, SourceURL: "hunter.io:" + domain})
	}
	return res.Data.Organization, out, nil
}

// ApolloCompanies finds companies through Apollo.io.
func (f *Finder) ApolloCompanies(ctx context.Context, country, industry, keywords string) ([]Site, error) {
	body := map[string]any{"page": 1, "per_page": 25}
	if country != "" {
		body["organization_locations"] = []string{catalog.CountryName(country)}
	}
	var tags []string
	for _, t := range []string{industry, keywords} {
		if t != "" {
			tags = append(tags, t)
		}
	}
	if len(tags) > 0 {
		body["q_organization_keyword_tags"] = tags
	}
	type org struct {
		Name          string `json:"name"`
		PrimaryDomain string `json:"primary_domain"`
		WebsiteURL    string `json:"website_url"`
	}
	var res struct {
		Organizations []org `json:"organizations"`
		Accounts      []org `json:"accounts"`
	}
	headers := map[string]string{"x-api-key": f.Secrets["apollo_api_key"], "cache-control": "no-cache"}
	if err := f.getJSON(ctx, http.MethodPost, f.endpoint(f.ApolloURL, "https://api.apollo.io/api/v1")+"/mixed_companies/search", headers, body, "Apollo", &res); err != nil {
		return nil, err
	}
	var out []Site
	for _, o := range append(res.Organizations, res.Accounts...) {
		domain := o.PrimaryDomain
		if domain == "" {
			domain = HostOf(o.WebsiteURL)
		}
		if domain == "" {
			continue
		}
		site := o.WebsiteURL
		if site == "" {
			site = "https://" + domain
		}
		out = append(out, Site{Website: site, Domain: domain, Company: o.Name, Source: "apollo"})
	}
	return out, nil
}
