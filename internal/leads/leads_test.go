package leads

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestExtractEmails(t *testing.T) {
	page := `<a href="mailto:Sales@Acme.com?subject=hi">mail</a>
		<span class="__cf_email__" data-cfemail="` + cfEncode("info@acme.com", 0x42) + `">[email protected]</span>
		<p>Write to support [at] acme [dot] com or hr@acme.com.</p>
		<script>var x = "hidden@acme.com"</script>
		<img src="logo@2x.png"> noreply@acme.com someone@example.com`
	got := ExtractEmails(page)
	want := []string{"sales@acme.com", "info@acme.com", "support@acme.com", "hr@acme.com"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExtractEmails = %v, want %v", got, want)
	}
}

func cfEncode(s string, key byte) string {
	const hex = "0123456789abcdef"
	out := []byte{hex[key>>4], hex[key&15]}
	for i := 0; i < len(s); i++ {
		b := s[i] ^ key
		out = append(out, hex[b>>4], hex[b&15])
	}
	return string(out)
}

func TestRobots(t *testing.T) {
	rules := ParseRobots("User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: Other\nDisallow: /", "EmailingLeadFinder/1.0")
	for path, want := range map[string]bool{"/": true, "/private/x": false, "/private/contact": true, "/about": true} {
		if got := PathAllowed(rules, path); got != want {
			t.Errorf("PathAllowed(%q) = %v", path, got)
		}
	}
}

func TestSitesAndLinks(t *testing.T) {
	sites := UniqueSites([]string{"https://www.acme.com/about", "https://acme.com/x", "https://facebook.com/acme", "http://beta.io"})
	if len(sites) != 2 || sites[0].Domain != "acme.com" || sites[1].Website != "http://beta.io" {
		t.Errorf("UniqueSites = %+v", sites)
	}
	links := ContactLinks(`<a href="/contact-us">Contact</a><a href="https://other.com/contact">x</a><a href="team.html">Our team</a><a href="/blog">Blog</a>`, "https://acme.com/en/")
	if !reflect.DeepEqual(links, []string{"https://acme.com/contact-us", "https://acme.com/en/team.html"}) {
		t.Errorf("ContactLinks = %v", links)
	}
	if SiteName(`<title>Acme Dental Lab | Home</title>`, "https://acme.com") != "Acme Dental Lab" {
		t.Error("SiteName")
	}
}

func TestCrawlSite(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("User-agent: *\nDisallow: /secret")) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<title>Acme</title><a href="/reach-us">Reach us</a><a href="/secret">Contact secret</a> ceo@gmail.com`))
	})
	mux.HandleFunc("/reach-us", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`hello@127.0.0.1.nip.io sales@acme.test`))
	})
	mux.HandleFunc("/secret", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`secret@acme.test`)) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	f := &Finder{Client: srv.Client(), Sleep: func(time.Duration) {}}
	company, site, emails := f.CrawlSite(context.Background(), srv.URL, 6)
	if company != "Acme" || site != strings.ToLower(srv.URL) {
		t.Errorf("company %q site %q", company, site)
	}
	var got []string
	for _, e := range emails {
		got = append(got, e.Email)
	}
	for _, e := range got {
		if e == "secret@acme.test" {
			t.Error("robots.txt disallowed /secret but it was crawled")
		}
	}
	if len(got) < 2 {
		t.Errorf("found %v", got)
	}
}

func TestDuckDuckGoPaging(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		r.ParseForm()
		if calls == 1 {
			w.Write([]byte(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2F&rut=x">Acme</a>
				<form action="/html/"><input type="hidden" name="q" value="x"><input type="hidden" name="s" value="10"><input type="submit" value="Next"></form>`))
			return
		}
		if r.Form.Get("s") != "10" {
			t.Errorf("second page form = %v", r.Form)
		}
		w.Write([]byte(`<a class="result__a" href="https://beta.io/">Beta</a>`))
	}))
	defer srv.Close()
	f := &Finder{Client: srv.Client(), Sleep: func(time.Duration) {}, DuckDuckGoURL: srv.URL}
	links, err := f.duckDuckGo(context.Background(), "q", "MY", 3)
	if err != nil || !reflect.DeepEqual(links, []string{"https://acme.com/", "https://beta.io/"}) {
		t.Errorf("links %v err %v", links, err)
	}
}
