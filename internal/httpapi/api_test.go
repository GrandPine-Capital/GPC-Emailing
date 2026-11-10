package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/auth"
	"github.com/grandpine-capital/gpc-emailing/internal/httpapi"
	"github.com/grandpine-capital/gpc-emailing/internal/ses"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

type nopSES struct{ sent []string }

func (m *nopSES) Region() string { return "ap-southeast-5" }
func (m *nopSES) Send(_ context.Context, raw []byte) (string, error) {
	m.sent = append(m.sent, string(raw))
	return "ses-1", nil
}
func (m *nopSES) Remaining(context.Context) (int, error)       { return 100, nil }
func (m *nopSES) Account(context.Context) (ses.Account, error) { return ses.Account{}, nil }
func (m *nopSES) Identities(context.Context) ([]ses.Identity, error) {
	return []ses.Identity{{Email: "grandpine.test", Type: "domain", Verified: true}}, nil
}
func (m *nopSES) PollEvents(context.Context, func(ses.Event) error) (int, error)       { return 0, nil }
func (m *nopSES) PollInbound(context.Context, func(string, []byte) error) (int, error) { return 0, nil }

func server(t *testing.T) (*httptest.Server, *app.Service, *nopSES) {
	db, box, key := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mail := &nopSES{}
	svc := app.New(db, box, key, "https://mail.test", mail, app.MailConfig{DefaultFrom: "hello@grandpine.test", ReplyDomain: "reply.grandpine.test"}, log)
	h := httpapi.New(httpapi.Deps{Service: svc, Staff: auth.DevVerifier{}, AuthMode: "dev", Log: log})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, svc, mail
}

func call(t *testing.T, srv *httptest.Server, method, path, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	b, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(b, &out)
	if out == nil {
		out = map[string]any{"_raw": string(b)}
	}
	return res.StatusCode, out
}

const (
	admin  = "dev:ann:admin"
	editor = "dev:ed:editor"
	viewer = "dev:vic:viewer"
)

func TestRolesAndRoutes(t *testing.T) {
	srv, _, _ := server(t)
	if code, _ := call(t, srv, "GET", "/api/meta", "", ""); code != 401 {
		t.Errorf("no token: %d", code)
	}
	if code, out := call(t, srv, "GET", "/api/me", editor, ""); code != 200 || out["role"] != "member" {
		t.Errorf("editor /me: %d %v", code, out)
	}
	if code, _ := call(t, srv, "POST", "/api/lists", viewer, `{"name":"x"}`); code != 403 {
		t.Errorf("viewer write: %d", code)
	}
	if code, _ := call(t, srv, "GET", "/api/lists", viewer, ""); code != 200 {
		t.Errorf("viewer read: %d", code)
	}
	if code, _ := call(t, srv, "PUT", "/api/settings", editor, `{"from_name":"x"}`); code != 403 {
		t.Errorf("editor settings: %d", code)
	}
	if code, _ := call(t, srv, "PUT", "/api/settings", admin, `{"from_name":"Acme","daily_limit":"250","timezone":"Mars/Base"}`); code != 400 {
		t.Errorf("bad time zone: %d", code)
	}
	if code, _ := call(t, srv, "PUT", "/api/settings", admin, `{"from_name":"Acme","daily_limit":"250","hunter_api_key":"hk"}`); code != 200 {
		t.Errorf("admin settings: %d", code)
	}
	_, s := call(t, srv, "GET", "/api/settings", editor, "")
	if s["from_name"] != "Acme" || s["daily_limit"] != float64(250) || s["hunter_api_key"] != "" || s["webhook_secret"] != "" {
		t.Errorf("editor sees settings without secrets: %v", s)
	}
	_, s = call(t, srv, "GET", "/api/settings", admin, "")
	if s["hunter_api_key"] != "hk" || !strings.Contains(s["generic_webhook_url"].(string), "https://mail.test/hook?k=") {
		t.Errorf("admin settings: %v", s)
	}

	// contact ids are e-mail addresses in the path
	if code, _ := call(t, srv, "POST", "/api/contacts", editor, `{"email":"Zed@Zeta.io","first_name":"Zed","tags":"a, b"}`); code != 200 {
		t.Fatalf("create contact: %d", code)
	}
	code, c := call(t, srv, "GET", "/api/contacts/"+url.PathEscape("zed@zeta.io"), editor, "")
	if code != 200 || c["first_name"] != "Zed" || len(c["tags"].([]any)) != 2 || c["messages"] == nil {
		t.Errorf("contact detail: %d %v", code, c)
	}
	if code, _ := call(t, srv, "PUT", "/api/contacts/zed@zeta.io", editor, `{"email":"zed@new.io","status":"nope"}`); code != 400 {
		t.Errorf("bad status: %d", code)
	}
	if code, c := call(t, srv, "PUT", "/api/contacts/zed@zeta.io", editor, `{"email":"zed@new.io"}`); code != 200 || c["id"] != "zed@new.io" {
		t.Errorf("rename contact: %d %v", code, c)
	}
	if code, out := call(t, srv, "GET", "/api/contacts?q=zed&page=1", editor, ""); code != 200 || out["total"] != float64(1) {
		t.Errorf("search: %d %v", code, out)
	}
	if code, _ := call(t, srv, "GET", "/api/templates/nope", editor, ""); code != 404 {
		t.Errorf("missing template: %d", code)
	}
	if code, out := call(t, srv, "POST", "/api/templates/std-welcome-email/test", editor, `{"email":"qa@test.io"}`); code != 200 || out["ok"] != true {
		t.Errorf("test e-mail: %d %v", code, out)
	}
}

func TestPublicRoutes(t *testing.T) {
	srv, svc, mb := server(t)
	noRedirect := *srv.Client()
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	res, _ := http.Get(srv.URL + "/o?t=abc")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/gif" {
		t.Errorf("pixel for an unknown token: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	res, _ = noRedirect.Get(srv.URL + "/r?t=000000000000000000000000&k=../evil")
	if res.StatusCode != 400 {
		t.Errorf("bad click params: %d", res.StatusCode)
	}
	res, _ = http.Get(srv.URL + "/u?t=000000000000000000000000")
	b, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(b), "preview or has expired") || !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Errorf("unsubscribe page for an unknown token: %s", b)
	}

	if code, _ := call(t, srv, "POST", "/hook?k=wrong", "", `{"email":"a@b.co"}`); code != 401 {
		t.Errorf("webhook with a wrong key: %d", code)
	}
	secret, _ := svc.WebhookSecret(context.Background())
	if code, out := call(t, srv, "POST", "/hook?k="+secret, "", `{"email":"Web@Hook.io","tags":"lead"}`); code != 200 || out["contact"] != "web@hook.io" {
		t.Errorf("webhook: %d %v", code, out)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/hook?k="+secret, strings.NewReader("email=form%40site.io&name=Form+Person"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, _ = http.DefaultClient.Do(req)
	b, _ = io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(b), "form@site.io") {
		t.Errorf("form-encoded webhook: %d %s", res.StatusCode, b)
	}

	// Send a campaign to that contact and use its one-click unsubscribe link.
	_, list := call(t, srv, "POST", "/api/lists", editor, `{"name":"L"}`)
	call(t, srv, "POST", "/api/lists/"+list["id"].(string)+"/contacts", editor, `{"contact_ids":["web@hook.io"]}`)
	_, camp := call(t, srv, "POST", "/api/campaigns", editor, `{"name":"C","template_id":"std-welcome-email","list_ids":["`+list["id"].(string)+`"]}`)
	if code, out := call(t, srv, "POST", "/api/campaigns/"+camp["id"].(string)+"/send", editor, ""); code != 200 {
		t.Fatalf("send: %d %v", code, out)
	}
	if code, out := call(t, srv, "POST", "/api/replies/poll", editor, ""); code != 200 {
		t.Fatalf("run worker: %d %v", code, out)
	}
	if _, c := call(t, srv, "GET", "/api/campaigns/"+camp["id"].(string), editor, ""); c["status"] != "sent" {
		t.Fatalf("campaign status %v", c["status"])
	}
	raw := mb.sent[len(mb.sent)-1]
	tok := regexp.MustCompile(`/u1\?t=([a-f0-9]{24})`).FindStringSubmatch(raw)
	if tok == nil {
		t.Fatal("no one-click unsubscribe link")
	}
	res, _ = http.Post(srv.URL+"/u1?t="+tok[1], "application/x-www-form-urlencoded", strings.NewReader("List-Unsubscribe=One-Click"))
	if res.StatusCode != 200 {
		t.Errorf("one-click: %d", res.StatusCode)
	}
	_, c := call(t, srv, "GET", "/api/contacts/web@hook.io", editor, "")
	if c["status"] != "unsubscribed" {
		t.Errorf("contact status %v", c["status"])
	}
}
