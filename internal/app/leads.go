package app

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/catalog"
	"github.com/grandpine-capital/gpc-emailing/internal/leads"
)

// A lead search runs across worker ticks; its progress is the state column (Leads.process).

type leadParams struct {
	Countries        []string `json:"countries"`
	Industries       []string `json:"industries"`
	Keywords         string   `json:"keywords"`
	Sources          []string `json:"sources"`
	URLs             []string `json:"urls"`
	Limit            int      `json:"limit"`
	PerSiteMaxEmails int      `json:"perSiteMaxEmails"`
	Pages            int      `json:"pages"`
}

type combo struct {
	Country  string `json:"country"`
	Industry string `json:"industry"`
}

type leadState struct {
	Combos     []combo      `json:"combos"`
	ComboIndex int          `json:"comboIndex"`
	Sites      []leads.Site `json:"sites"`
	SiteIndex  int          `json:"siteIndex"`
	Count      int          `json:"count"`
	Errors     []string     `json:"errors"`
}

var schemeRe = regexp.MustCompile(`(?i)^https?://`)

func initLeadState(p leadParams) leadState {
	countries, industries := p.Countries, p.Industries
	if len(countries) == 0 {
		countries = []string{""}
	}
	if len(industries) == 0 {
		industries = []string{""}
	}
	st := leadState{Combos: []combo{}, Sites: []leads.Site{}, Errors: []string{}}
	for _, c := range countries {
		for _, i := range industries {
			if c != "" || i != "" || p.Keywords != "" {
				st.Combos = append(st.Combos, combo{c, i})
			}
		}
	}
	if contains(p.Sources, "urls") {
		for _, u := range p.URLs {
			u = strings.TrimSpace(u)
			if u == "" {
				continue
			}
			if !schemeRe.MatchString(u) {
				u = "https://" + u
			}
			st.Sites = append(st.Sites, leads.Site{Website: leads.OriginOf(u), Domain: leads.HostOf(u), Source: "crawl", Country: countries[0], Industry: industries[0]})
		}
	}
	return st
}

// processLeads advances the oldest pending lead search while time remains.
func (s *Service) processLeads(ctx context.Context, hasTime func() bool) (int, error) {
	var id string
	var paramsRaw, stateRaw []byte
	err := s.db.Pool.QueryRow(ctx, `SELECT id, params, state FROM lead_searches WHERE status IN ('running', 'queued')
		ORDER BY (status = 'running') DESC, created_at LIMIT 1`).Scan(&id, &paramsRaw, &stateRaw)
	if err != nil {
		if IsNotFound(mapNoRows(err)) {
			return 0, nil
		}
		return 0, err
	}
	var p leadParams
	_ = json.Unmarshal(paramsRaw, &p)
	var st leadState
	if len(stateRaw) == 0 || json.Unmarshal(stateRaw, &st) != nil || st.Combos == nil {
		st = initLeadState(p)
	}
	sources := p.Sources
	if len(sources) == 0 {
		sources = []string{"web"}
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, 1000)
	perSite := p.PerSiteMaxEmails
	if perSite <= 0 {
		perSite = 3
	}
	pages := min(max(p.Pages, 1), 5)
	if p.Pages == 0 {
		pages = 2
	}
	sec := s.Secrets(ctx)
	settings := s.Settings(ctx)
	f := &leads.Finder{Client: s.Outbound, UserAgent: settings.CrawlerUserAgent, Secrets: sec}

	seen := map[string]bool{}
	for _, site := range st.Sites {
		seen[site.Domain] = true
	}
	save := func(status, progress string, final bool) error {
		uniq := []string{}
		for _, e := range st.Errors {
			if !contains(uniq, e) {
				uniq = append(uniq, e)
			}
		}
		if len(uniq) > 20 {
			uniq = uniq[len(uniq)-20:]
		}
		st.Errors = uniq
		state, _ := json.Marshal(st)
		if progress == "" {
			progress = fmt.Sprintf("Checked %d of %d websites, found %d emails", st.SiteIndex, len(st.Sites), st.Count)
		}
		var errText *string
		if len(uniq) > 0 {
			e := strings.Join(uniq, "\n")
			errText = &e
		}
		q := `UPDATE lead_searches SET status = $2, state = $3::jsonb, results_count = $4, progress = $5, error = $6`
		if final {
			q += `, finished_at = now()`
		}
		_, err := s.db.Pool.Exec(ctx, q+` WHERE id = $1`, id, status, string(state), st.Count, progress, errText)
		return err
	}
	addSites := func(list []leads.Site, c combo) {
		for _, site := range list {
			if site.Domain == "" || seen[site.Domain] {
				continue
			}
			seen[site.Domain] = true
			if site.Country == "" {
				site.Country = c.Country
			}
			if site.Industry == "" {
				site.Industry = c.Industry
			}
			st.Sites = append(st.Sites, site)
		}
	}
	use := func(src string) bool { return contains(sources, src) }

	// 1) Discover company websites for each country × industry.
	for st.ComboIndex < len(st.Combos) && hasTime() {
		c := st.Combos[st.ComboIndex]
		if use("hunter") && sec["hunter_api_key"] != "" {
			if list, err := f.HunterDiscover(ctx, c.Country, c.Industry, p.Keywords); err != nil {
				st.Errors = append(st.Errors, err.Error())
			} else {
				addSites(list, c)
			}
		}
		if use("apollo") && sec["apollo_api_key"] != "" {
			if list, err := f.ApolloCompanies(ctx, c.Country, c.Industry, p.Keywords); err != nil {
				st.Errors = append(st.Errors, err.Error())
			} else {
				addSites(list, c)
			}
		}
		if use("web") {
			if list, err := f.WebSearch(ctx, c.Country, c.Industry, p.Keywords, pages); err != nil {
				st.Errors = append(st.Errors, err.Error())
			} else {
				addSites(list, c)
			}
		}
		st.ComboIndex++
		if err := save("running", "", false); err != nil {
			return 1, err
		}
	}
	// 2) Collect addresses per website.
	for st.ComboIndex >= len(st.Combos) && st.SiteIndex < len(st.Sites) && st.Count < limit && hasTime() {
		site := st.Sites[st.SiteIndex]
		company := site.Company
		country := ""
		if site.Country != "" {
			country = catalog.CountryName(site.Country)
		}
		var found []leads.Found
		source := site.Source
		if use("hunter") && sec["hunter_api_key"] != "" {
			if org, list, err := f.HunterDomain(ctx, site.Domain, perSite); err != nil {
				st.Errors = append(st.Errors, err.Error())
			} else {
				if company == "" {
					company = org
				}
				found, source = list, "hunter"
			}
		}
		if len(found) == 0 {
			name, _, list := f.CrawlSite(ctx, site.Website, 6)
			if company == "" {
				company = name
			}
			found = list
			if source == "" || source == "hunter" {
				source = "crawl"
			}
		}
		if len(found) > perSite {
			found = found[:perSite]
		}
		for _, l := range found {
			if st.Count >= limit {
				break
			}
			email := leads.CleanEmail(l.Email)
			if email == "" {
				continue
			}
			tag, err := s.db.Pool.Exec(ctx, `INSERT INTO leads (id, search_id, email, first_name, last_name, position, company, website, country, industry, source, source_url)
				VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
				email, id, l.FirstName, l.LastName, l.Position, company, site.Website, country, site.Industry, source, l.SourceURL)
			if err != nil {
				return 1, err
			}
			if tag.RowsAffected() > 0 {
				st.Count++
			}
		}
		st.SiteIndex++
		if err := save("running", "", false); err != nil {
			return 1, err
		}
	}
	if st.ComboIndex >= len(st.Combos) && (st.SiteIndex >= len(st.Sites) || st.Count >= limit) {
		return 1, save("done", fmt.Sprintf("Done - checked %d websites, found %d emails", st.SiteIndex, st.Count), true)
	}
	return 1, nil
}
