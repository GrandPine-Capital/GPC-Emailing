package app_test

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

const ourHookURL = "https://mail.test/hooks/whatsapp"

// fakeWAPlatform is GPC-WhatsApp's /me and /webhooks.
type fakeWAPlatform struct {
	mu        sync.Mutex
	server    *httptest.Server
	scopes    []string
	hooks     []map[string]any // what GET /webhooks lists
	posts     []map[string]any
	deleted   []string
	calls     int
	failPosts int // answer POST /webhooks with 503 this many times
}

func newFakeWAPlatform(t *testing.T, scopes ...string) *fakeWAPlatform {
	f := &fakeWAPlatform{scopes: scopes}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/me":
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant": map[string]any{"id": "t"}, "apiKey": map[string]any{"id": "k", "scopes": f.scopes}})
		case r.Method == "GET" && r.URL.Path == "/api/v1/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": f.hooks})
		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/v1/webhooks/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/webhooks/")
			f.deleted = append(f.deleted, id)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case r.Method == "POST" && r.URL.Path == "/api/v1/webhooks":
			if f.failPosts > 0 {
				f.failPosts--
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"message":"down for gpc_live_test"}}`))
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.posts = append(f.posts, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": fmt.Sprintf("wh-new-%d", len(f.posts)), "url": body["url"], "events": body["events"], "secret": waHookSecret}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (e *env) connectPlatform(t *testing.T, f *fakeWAPlatform) {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_url": f.server.URL, "gpc_whatsapp_key": "gpc_live_test"}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) hookState(t *testing.T) map[string]any {
	t.Helper()
	v, err := e.svc.SettingsView(e.ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	return v["gpc_whatsapp_webhook"].(map[string]any)
}

func TestWebhookAutoSetupCreatesAndVerifies(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "read", "webhooks:write")
	f.hooks = []map[string]any{{"id": "wh-other", "url": "https://elsewhere.test/hooks/whatsapp"}}
	e.connectPlatform(t, f) // saving the connection sets the webhook up at once
	if len(f.posts) != 1 {
		t.Fatalf("posts = %d", len(f.posts))
	}
	p := f.posts[0]
	evs, _ := json.Marshal(p["events"])
	if p["url"] != ourHookURL || string(evs) != `["message.received","message.status"]` {
		t.Fatalf("post body %v", p)
	}
	if len(f.deleted) != 0 {
		t.Fatalf("another URL's webhook was deleted: %v", f.deleted)
	}
	if st := e.hookState(t); st["state"] != "connected" || st["at"] == nil {
		t.Fatalf("state %v", st)
	}
	if e.svc.Secrets(e.ctx)["gpc_whatsapp_webhook_secret"] != waHookSecret {
		t.Fatal("secret not stored")
	}
	// the stored secret now accepts a signed delivery
	if out := e.waHook(t, "message.received", waReceived("m-auto", "60123456789", "hello")); out["ok"] != true {
		t.Fatalf("delivery: %v", out)
	}
	// never returned by GET /settings
	v, _ := e.svc.SettingsView(e.ctx, true)
	if v["gpc_whatsapp_webhook_secret"] != "" || strings.Contains(fmt.Sprint(v["gpc_whatsapp_webhook"]), waHookSecret) {
		t.Fatal("secret leaked in settings view")
	}
	// saving the form again (it posts the field back empty) keeps the secret and makes no call
	calls := f.calls
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_webhook_secret": "", "gpc_whatsapp_url": f.server.URL, "gpc_whatsapp_key": "gpc_live_test"}); err != nil {
		t.Fatal(err)
	}
	if e.svc.Secrets(e.ctx)["gpc_whatsapp_webhook_secret"] != waHookSecret || f.calls != calls {
		t.Fatal("an unchanged save changed the secret or called the platform")
	}
}

func TestWebhookAutoSetupReplacesOurOwn(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "*")
	f.hooks = []map[string]any{{"id": "wh-old", "url": ourHookURL}, {"id": "wh-other", "url": ourHookURL + "/x"}}
	e.connectPlatform(t, f)
	if len(f.deleted) != 1 || f.deleted[0] != "wh-old" || len(f.posts) != 1 {
		t.Fatalf("deleted %v posts %d", f.deleted, len(f.posts))
	}
	if e.hookState(t)["state"] != "connected" {
		t.Fatal("not connected")
	}
}

func TestWebhookAutoSetupNeedsScope(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "read", "messages:write")
	e.connectPlatform(t, f)
	if len(f.posts) != 0 || e.hookState(t)["state"] != "needs_scope" {
		t.Fatalf("posts %d state %v", len(f.posts), e.hookState(t))
	}
	if e.svc.Secrets(e.ctx)["gpc_whatsapp_webhook_secret"] != "" {
		t.Fatal("secret set")
	}
	// the key is given the scope; the button connects it
	f.scopes = []string{"read", "webhooks:write"}
	if got := e.svc.EnsureWhatsAppWebhook(e.ctx); got != "connected" {
		t.Fatalf("after adding the scope: %q", got)
	}
}

func TestWebhookAutoSetupFailureRetriesAfterInterval(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "webhooks:write")
	f.failPosts = 1
	e.connectPlatform(t, f)
	st := e.hookState(t)
	if st["state"] != "failed" || !strings.Contains(fmt.Sprint(st["reason"]), "503") || strings.Contains(fmt.Sprint(st), "gpc_live") {
		t.Fatalf("state %v", st)
	}
	calls := f.calls
	e.now = e.now.Add(10 * time.Minute)
	e.tick(t)
	if f.calls != calls {
		t.Fatal("retried before the interval")
	}
	e.now = e.now.Add(21 * time.Minute)
	e.tick(t)
	if f.calls == calls || e.hookState(t)["state"] != "connected" {
		t.Fatalf("not retried: calls %d state %v", f.calls, e.hookState(t))
	}
	calls = f.calls
	e.now = e.now.Add(2 * time.Hour)
	e.tick(t)
	if f.calls != calls {
		t.Fatal("called again once connected")
	}
}

func TestWebhookAutoSetupUnreachable(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "*")
	f.server.Close()
	e.connectPlatform(t, f)
	if st := e.hookState(t); st["state"] != "failed" || st["reason"] != "unreachable" {
		t.Fatalf("state %v", st)
	}
}

func TestWebhookAutoSetupNoCallWhenSecretSetOrNotConnected(t *testing.T) {
	e := setup(t, true)
	f := newFakeWAPlatform(t, "*")
	if got := e.svc.EnsureWhatsAppWebhook(e.ctx); got != "" {
		t.Fatalf("not connected: %q", got)
	}
	e.waHookOn(t) // a secret typed by hand
	e.connectPlatform(t, f)
	if got := e.svc.EnsureWhatsAppWebhook(e.ctx); got != "" || f.calls != 0 {
		t.Fatalf("secret set: %q, %d calls", got, f.calls)
	}
	if e.hookState(t)["state"] != "manual" {
		t.Fatalf("state %v", e.hookState(t))
	}
	e.tick(t)
	if f.calls != 0 {
		t.Fatal("the worker called the platform")
	}
}

func TestWebhookAutoSetupNoBaseURL(t *testing.T) {
	e := setup(t, true)
	db, box, key := testdb.New(t)
	e.svc = app.New(db, box, key, "", e.ses, mailCfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.svc.Now = func() time.Time { return e.now }
	f := newFakeWAPlatform(t, "*")
	e.connectPlatform(t, f)
	if f.calls != 0 || e.hookState(t)["state"] != "no_url" {
		t.Fatalf("calls %d state %v", f.calls, e.hookState(t))
	}
}
