package app_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

// fakeChatDaddy records every request made to the stand-in for api.chatdaddy.tech.
type fakeChatDaddy struct {
	mu    sync.Mutex
	paths []string
}

func (f *fakeChatDaddy) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.paths...)
}

func newFakeChatDaddy(t *testing.T) *fakeChatDaddy {
	f := &fakeChatDaddy{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		w.WriteHeader(200)
	}))
	old := app.ChatDaddyAPI
	app.ChatDaddyAPI = srv.URL
	t.Cleanup(func() { app.ChatDaddyAPI = old; srv.Close() })
	return f
}

func (e *env) set(t *testing.T, kv map[string]any) {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, kv); err != nil {
		t.Fatal(err)
	}
}

func (e *env) runLog(t *testing.T, run string) string {
	t.Helper()
	return e.scalar(t, `SELECT log::text FROM runs WHERE id = $1`, run).(string)
}

func TestChatDaddySwitchDefault(t *testing.T) {
	// A token and the saved provider chatdaddy: this installation uses ChatDaddy, so it stays on.
	e := setup(t, true)
	e.set(t, map[string]any{"whatsapp_provider": "chatdaddy", "chatdaddy_token": "cdtok"})
	if !e.svc.ChatDaddyOn(e.ctx) {
		t.Error("token + provider chatdaddy should default to on")
	}
	// No token: off.
	e = setup(t, true)
	e.set(t, map[string]any{"whatsapp_provider": "chatdaddy"})
	if e.svc.ChatDaddyOn(e.ctx) {
		t.Error("no token should default to off")
	}
	// A token but the provider is GPC-WhatsApp: off.
	e = setup(t, true)
	e.set(t, map[string]any{"whatsapp_provider": "gpc_whatsapp", "chatdaddy_token": "cdtok"})
	if e.svc.ChatDaddyOn(e.ctx) {
		t.Error("token with provider gpc_whatsapp should default to off")
	}
	// Nothing at all: off.
	e = setup(t, true)
	if e.svc.ChatDaddyOn(e.ctx) {
		t.Error("a fresh installation starts with it off")
	}
}

func TestChatDaddySwitchSavedValueWins(t *testing.T) {
	e := setup(t, true)
	e.set(t, map[string]any{"whatsapp_provider": "chatdaddy", "chatdaddy_token": "cdtok"})
	e.set(t, map[string]any{"chatdaddy_enabled": false})
	if e.svc.ChatDaddyOn(e.ctx) {
		t.Error("a saved off beats the derived on")
	}
	e = setup(t, true)
	e.set(t, map[string]any{"chatdaddy_enabled": true})
	if !e.svc.ChatDaddyOn(e.ctx) {
		t.Error("a saved on beats the derived off")
	}
	// Saving something else does not touch it, and the settings view shows the effective value.
	e.set(t, map[string]any{"from_name": "Acme"})
	if !e.svc.ChatDaddyOn(e.ctx) {
		t.Error("saving other settings must not flip the switch")
	}
	v, err := e.svc.SettingsView(e.ctx, true)
	if err != nil || v["chatdaddy_enabled"] != true {
		t.Errorf("view %v %v", v["chatdaddy_enabled"], err)
	}
	// The form posts the effective value back: a derived on is saved as on, and stays on when the token is cleared later.
	e = setup(t, true)
	e.set(t, map[string]any{"whatsapp_provider": "chatdaddy", "chatdaddy_token": "cdtok"})
	v, _ = e.svc.SettingsView(e.ctx, true)
	e.set(t, map[string]any{"chatdaddy_enabled": v["chatdaddy_enabled"], "whatsapp_provider": "gpc_whatsapp"})
	if !e.svc.ChatDaddyOn(e.ctx) {
		t.Error("the value the form posted is now saved and wins")
	}
}

func TestChatDaddySwitchOffSendsViaGPC(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	cd := newFakeChatDaddy(t)
	e.set(t, map[string]any{"chatdaddy_token": "cdtok", "chatdaddy_enabled": false})
	run := e.waAutomation(t, map[string]any{"type": "send_whatsapp", "provider": "chatdaddy", "text": "Hi {{first_name}}"})
	sent := wa.sends()
	if len(sent) != 1 || sent[0]["ref"] != run || sent[0]["idempotencyKey"] != "emailing:"+run+"#0" || sent[0]["text"] != "Hi Wei" {
		t.Fatalf("platform sends %v", sent)
	}
	if len(cd.calls()) != 0 {
		t.Errorf("ChatDaddy must not be called: %v", cd.calls())
	}
	if log := e.runLog(t, run); !strings.Contains(log, "GPC-WhatsApp") || !strings.Contains(log, "switched off") {
		t.Errorf("the note should say it went via GPC-WhatsApp: %s", log)
	}
	// The workspace setting chatdaddy, a notify step and the test send follow the same rule.
	e.set(t, map[string]any{"whatsapp_provider": "chatdaddy"})
	if _, err := e.svc.SendWhatsApp(e.ctx, "0198765432", app.WhatsAppOpts{Text: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.SendWhatsApp(e.ctx, "0198765432", app.WhatsAppOpts{Provider: "chatdaddy", Text: "y"}); err != nil {
		t.Fatal(err)
	}
	if len(wa.sends()) != 3 || len(cd.calls()) != 0 {
		t.Errorf("platform %d, chatdaddy %v", len(wa.sends()), cd.calls())
	}
}

func TestChatDaddySwitchOffSkipsContactStep(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	cd := newFakeChatDaddy(t)
	e.set(t, map[string]any{"chatdaddy_token": "cdtok", "chatdaddy_enabled": false})
	run := e.waAutomation(t, map[string]any{"type": "chatdaddy_contact", "tags": "lead"}, map[string]any{"type": "send_whatsapp", "text": "Hi"})
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "completed" {
		t.Error("the run goes on to the next step")
	}
	if log := e.runLog(t, run); !strings.Contains(log, "ChatDaddy is switched off (Settings → Integrations): step skipped") {
		t.Errorf("log %s", log)
	}
	if len(cd.calls()) != 0 || len(wa.sends()) != 1 {
		t.Errorf("chatdaddy %v, platform %d", cd.calls(), len(wa.sends()))
	}
}

func TestChatDaddySwitchOffIgnoresInboundWebhook(t *testing.T) {
	e := setup(t, true)
	secret, err := e.svc.WebhookSecret(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"event":"message-insert","data":[{"id":"wa1","chatId":"60123456789@s.whatsapp.net","text":"Hi","sender":{"name":"Eve"}}]}`)
	out, err := e.svc.HandleWebhook(e.ctx, map[string]string{"k": secret, "src": "chatdaddy"}, body)
	if err != nil || out["ok"] != true || out["ignored"] != "ChatDaddy is switched off" {
		t.Fatalf("%v %v", out, err)
	}
	if e.scalar(t, `SELECT count(*) FROM replies`).(int64) != 0 || e.scalar(t, `SELECT count(*) FROM contacts`).(int64) != 0 {
		t.Error("nothing may be recorded")
	}
	// Other sources are unaffected.
	out, err = e.svc.HandleWebhook(e.ctx, map[string]string{"k": secret, "event": "form"}, []byte(`{"email":"eve@epsilon.io"}`))
	if err != nil || out["contact"] != "eve@epsilon.io" {
		t.Fatalf("generic webhook %v %v", out, err)
	}
	// On: recorded as before.
	e.set(t, map[string]any{"chatdaddy_enabled": true})
	out, err = e.svc.HandleWebhook(e.ctx, map[string]string{"k": secret, "src": "chatdaddy"}, body)
	if err != nil || out["handled"] != 1 {
		t.Fatalf("%v %v", out, err)
	}
	if e.scalar(t, `SELECT count(*) FROM replies WHERE channel = 'whatsapp'`).(int64) != 1 {
		t.Error("recorded when on")
	}
}

func TestChatDaddySwitchOnCallsChatDaddy(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	cd := newFakeChatDaddy(t)
	e.set(t, map[string]any{"chatdaddy_token": "cdtok", "chatdaddy_enabled": true})
	run := e.waAutomation(t, map[string]any{"type": "chatdaddy_contact", "tags": "lead"}, map[string]any{"type": "send_whatsapp", "provider": "chatdaddy", "text": "Hi"})
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "completed" {
		t.Error("run should complete")
	}
	calls := cd.calls()
	if len(calls) != 2 || calls[0] != "/contacts/upsert" || calls[1] != "/messages/random/60123456789" || len(wa.auth) != 0 {
		t.Errorf("chatdaddy %v, platform posts %d", calls, len(wa.auth))
	}
}
