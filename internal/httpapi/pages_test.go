package httpapi_test

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

func body(t *testing.T, res *http.Response, err error) string {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// The public opt-in and opt-out pages: a hosted form, the confirmation link, the preference
// page, the unsubscribe page with a reason, and "view in browser".
func TestSubscribeFormAndSubscriberPages(t *testing.T) {
	srv, _, mb := server(t)
	const editor = "dev:eva:editor"
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	_, list := call(t, srv, "POST", "/api/lists", editor, `{"name":"Newsletter","is_public":true}`)
	listID := list["id"].(string)
	if list["is_public"] != true {
		t.Fatalf("list = %v", list)
	}
	if code, _ := call(t, srv, "POST", "/api/forms", "dev:vic:viewer", `{"name":"F"}`); code != 403 {
		t.Errorf("a viewer creating a form: %d", code)
	}
	code, form := call(t, srv, "POST", "/api/forms", editor, `{"name":"Site","title":"Join <us>","fields":["first_name"],"list_ids":["`+listID+`"],"tags":"web","double_optin":true}`)
	if code != 200 {
		t.Fatalf("create form: %d %v", code, form)
	}
	formURL := srv.URL + "/f/" + form["id"].(string)

	res, err := http.Get(formURL)
	page := body(t, res, err)
	if res.StatusCode != 200 || !strings.Contains(page, "Join &lt;us&gt;") || !strings.Contains(page, `name="first_name"`) || strings.Contains(page, `name="company"`) ||
		!strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("form page: %d %s", res.StatusCode, page)
	}
	if res, _ := http.Get(srv.URL + "/f/nope"); res.StatusCode != 404 {
		t.Errorf("unknown form: %d", res.StatusCode)
	}
	// A bot that fills the hidden field is thanked and ignored.
	res, err = http.PostForm(formURL, url.Values{"email": {"bot@spam.io"}, "hp": {"x"}})
	if page = body(t, res, err); res.StatusCode != 200 || !strings.Contains(page, "Thank you") {
		t.Fatalf("honeypot: %d %s", res.StatusCode, page)
	}
	if code, _ := call(t, srv, "GET", "/api/contacts/bot@spam.io", editor, ""); code != 404 {
		t.Errorf("the bot became a contact: %d", code)
	}
	res, err = http.PostForm(formURL, url.Values{"email": {"not an address"}, "first_name": {"Kim"}})
	if page = body(t, res, err); res.StatusCode != 400 || !strings.Contains(page, "valid email") || !strings.Contains(page, `value="Kim"`) {
		t.Fatalf("invalid sign-up: %d %s", res.StatusCode, page)
	}
	res, err = http.PostForm(formURL, url.Values{"email": {"Kim@Kappa.io"}, "first_name": {"Kim"}})
	if page = body(t, res, err); res.StatusCode != 200 || !strings.Contains(page, "click the link") {
		t.Fatalf("sign-up: %d %s", res.StatusCode, page)
	}
	// A script on another site posts JSON and reads the answer.
	req, _ := http.NewRequest("POST", formURL, strings.NewReader(`{"email":"lee@lambda.io"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if out := body(t, res, err); res.StatusCode != 200 || !strings.Contains(out, `"status":"pending"`) || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("JSON sign-up: %d %s", res.StatusCode, out)
	}
	if _, c := call(t, srv, "GET", "/api/contacts/kim@kappa.io", editor, ""); c["status"] != "pending" || c["source"] != "form" {
		t.Fatalf("contact after sign-up: %v", c)
	}

	if code, out := call(t, srv, "POST", "/api/replies/poll", editor, ""); code != 200 {
		t.Fatalf("run worker: %d %v", code, out)
	}
	var link string
	for _, raw := range mb.sent {
		if strings.Contains(raw, "kim@kappa.io") {
			if m := regexp.MustCompile(`https://mail\.test(/c\?t=[A-Za-z0-9_.-]+)`).FindStringSubmatch(decodeParts(raw)); m != nil {
				link = m[1]
			}
		}
	}
	if link == "" {
		t.Fatalf("no confirmation e-mail among %d", len(mb.sent))
	}
	// Opening the link confirms nothing (mail scanners follow links); the button does.
	res, err = http.Get(srv.URL + link)
	if page = body(t, res, err); !strings.Contains(page, "kim@kappa.io") || !strings.Contains(page, "Yes, subscribe me") {
		t.Fatalf("confirm page: %s", page)
	}
	if _, c := call(t, srv, "GET", "/api/contacts/kim@kappa.io", editor, ""); c["status"] != "pending" {
		t.Fatal("a GET must not confirm")
	}
	res, err = http.Post(srv.URL+link, "application/x-www-form-urlencoded", nil)
	if page = body(t, res, err); res.StatusCode != 200 || !strings.Contains(page, "confirmed") {
		t.Fatalf("confirm: %d %s", res.StatusCode, page)
	}
	_, c := call(t, srv, "GET", "/api/contacts/kim@kappa.io", editor, "")
	if c["status"] != "subscribed" || c["confirmed_at"] == nil || len(c["list_ids"].([]any)) != 1 || c["tags"].([]any)[0] != "web" {
		t.Fatalf("contact after confirming: %v", c)
	}
	res, err = http.Get(srv.URL + "/c?t=bogus.token")
	if page = body(t, res, err); !strings.Contains(page, "expired") {
		t.Fatalf("bogus confirmation link: %s", page)
	}
	// With a landing page set in Settings, confirming goes there.
	if code, out := call(t, srv, "PUT", "/api/settings", "dev:ann:admin", `{"optin_redirect_url":"javascript:x"}`); code != 400 {
		t.Errorf("a bad redirect address: %d %v", code, out)
	}
	call(t, srv, "PUT", "/api/settings", "dev:ann:admin", `{"optin_redirect_url":"https://grandpine.test/welcome"}`)
	res, _ = noRedirect.Post(srv.URL+link, "application/x-www-form-urlencoded", nil)
	if res.StatusCode != 303 || res.Header.Get("Location") != "https://grandpine.test/welcome" {
		t.Errorf("confirm with a landing page: %d %s", res.StatusCode, res.Header.Get("Location"))
	}

	// Send Kim a campaign by tag, then use the links in it.
	_, camp := call(t, srv, "POST", "/api/campaigns", editor, `{"name":"C","template_id":"std-welcome-email","tags":["web"]}`)
	if camp["recipients"] != float64(1) {
		t.Fatalf("recipients = %v", camp["recipients"])
	}
	call(t, srv, "POST", "/api/campaigns/"+camp["id"].(string)+"/send", editor, "")
	call(t, srv, "POST", "/api/replies/poll", editor, "")
	tok := regexp.MustCompile(`/m\?t=([a-f0-9]{24})`).FindStringSubmatch(decodeParts(mb.sent[len(mb.sent)-1]))
	if tok == nil {
		t.Fatal("no preference link in the campaign e-mail")
	}
	res, err = http.Get(srv.URL + "/m?t=" + tok[1])
	if page = body(t, res, err); !strings.Contains(page, "Newsletter") || !strings.Contains(page, "checked") || !strings.Contains(page, `value="Kim"`) {
		t.Fatalf("preference page: %s", page)
	}
	res, err = http.PostForm(srv.URL+"/m?t="+tok[1], url.Values{"first_name": {"Kimberly"}, "last_name": {"K"}})
	if page = body(t, res, err); !strings.Contains(page, "preferences are saved") || strings.Contains(page, "checked") {
		t.Fatalf("saved preferences: %s", page)
	}
	if _, c = call(t, srv, "GET", "/api/contacts/kim@kappa.io", editor, ""); c["first_name"] != "Kimberly" || len(c["list_ids"].([]any)) != 0 || c["status"] != "subscribed" {
		t.Fatalf("contact after saving preferences: %v", c)
	}
	res, err = http.Get(srv.URL + "/m?t=test")
	if page = body(t, res, err); !strings.Contains(page, "preview or has expired") {
		t.Fatalf("preference page for a preview: %s", page)
	}

	res, err = http.Get(srv.URL + "/v?t=" + tok[1])
	if page = body(t, res, err); !strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox") || !strings.Contains(page, "<html") || strings.Contains(page, "/o?t=") {
		t.Fatalf("view online: %s %s", res.Header.Get("Content-Security-Policy"), page[:min(200, len(page))])
	}

	res, err = http.Get(srv.URL + "/u?t=" + tok[1])
	if page = body(t, res, err); !strings.Contains(page, "Would you tell us why") || !strings.Contains(page, "too many emails") {
		t.Fatalf("unsubscribe page: %s", page)
	}
	res, err = http.PostForm(srv.URL+"/u?t="+tok[1], url.Values{"reason": {"Other"}, "other": {"Changed jobs"}})
	if page = body(t, res, err); !strings.Contains(page, "unsubscribed") {
		t.Fatalf("unsubscribe: %s", page)
	}
	if _, c = call(t, srv, "GET", "/api/contacts/kim@kappa.io", editor, ""); c["status"] != "unsubscribed" || c["unsubscribe_reason"] != "Changed jobs" {
		t.Fatalf("contact after unsubscribing: %v %v", c["status"], c["unsubscribe_reason"])
	}

	// Tags, as the dashboard lists and renames them.
	req, _ = http.NewRequest("GET", srv.URL+"/api/tags", nil)
	req.Header.Set("Authorization", "Bearer "+editor)
	res, err = http.DefaultClient.Do(req)
	if out := body(t, res, err); !strings.Contains(out, `"tag":"web"`) {
		t.Fatalf("tags: %s", out)
	}
	if code, out := call(t, srv, "POST", "/api/tags/rename", editor, `{"from":"web","to":"website"}`); code != 200 || out["count"] != float64(1) {
		t.Fatalf("rename tag: %d %v", code, out)
	}
	if _, f := call(t, srv, "GET", "/api/forms/"+form["id"].(string), editor, ""); f["tags"].([]any)[0] != "website" || f["submissions"] != float64(2) {
		t.Fatalf("form after renaming its tag: %v", f)
	}
}

// decodeParts appends a raw message's base64 parts, decoded.
func decodeParts(raw string) string {
	out := raw
	for _, m := range regexp.MustCompile(`(?s)Content-Transfer-Encoding: base64\r\n\r\n(.*?)\r\n--`).FindAllStringSubmatch(raw, -1) {
		b, _ := base64Decode(strings.ReplaceAll(m[1], "\r\n", ""))
		out += "\n" + string(b)
	}
	return out
}

func base64Decode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
