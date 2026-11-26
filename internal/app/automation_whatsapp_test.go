package app_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

// waAutomation connects the fake platform, adds a contact and runs a manual automation with the
// given steps once. It returns the run id.
func (e *env) waAutomation(t *testing.T, steps ...any) string {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"default_country_code": "60"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CreateContact(e.ctx, app.ContactInput{Email: "wei@example.com", FirstName: "Wei", Phone: "012-345 6789"}); err != nil {
		t.Fatal(err)
	}
	a, err := e.svc.CreateAutomation(e.ctx, map[string]any{"name": "WA", "trigger_type": "manual", "status": "active", "steps": steps})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := e.svc.Enroll(e.ctx, a["id"].(string), []string{"wei@example.com"}, ""); err != nil || n != 1 {
		t.Fatalf("enroll %d %v", n, err)
	}
	e.tick(t)
	return e.scalar(t, `SELECT id FROM runs WHERE automation_id = $1`, a["id"]).(string)
}

func TestAutomationWhatsAppIsGPCByDefault(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	if p := e.svc.Settings(e.ctx).WhatsAppProvider; p != "gpc_whatsapp" {
		t.Fatalf("default provider %q", p)
	}
	run := e.waAutomation(t, map[string]any{"type": "send_whatsapp", "text": "Hi {{first_name}}"})
	sent := wa.sends()
	if len(sent) != 1 {
		t.Fatalf("sent %v", sent)
	}
	b := sent[0]
	if b["type"] != "text" || b["text"] != "Hi Wei" || b["to"] != "60123456789" || b["ref"] != run || b["idempotencyKey"] != "emailing:"+run+"#0" {
		t.Errorf("body %v", b)
	}
	if _, has := b["channelId"]; has {
		t.Errorf("no channel is set, so none is sent: %v", b)
	}
	if wa.auth[0] != "Bearer gpc_live_test" {
		t.Errorf("auth %q", wa.auth[0])
	}
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "completed" {
		t.Error("run should be completed")
	}
	// Recorded where automation sends are, under the platform's message id.
	if e.scalar(t, `SELECT id FROM whatsapp WHERE direction = 'out'`) != "wa-wa-1" {
		t.Error("the send should be recorded with the platform's message id")
	}
}

func TestAutomationWhatsAppChannelAndTemplate(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_channel": "ch-waba"}); err != nil {
		t.Fatal(err)
	}
	e.waAutomation(t,
		map[string]any{"type": "send_whatsapp", "template_name": "follow_up", "language": "ms", "params": "{{first_name}} | {{company}} | Offer"},
		map[string]any{"type": "send_whatsapp", "template_name": "follow_up", "params": "x"})
	sent := wa.sends()
	if len(sent) != 2 {
		t.Fatalf("sent %v", sent)
	}
	b := sent[0]
	tpl, _ := b["template"].(map[string]any)
	if b["type"] != "template" || b["channelId"] != "ch-waba" || tpl["name"] != "follow_up" || tpl["language"] != "ms" {
		t.Errorf("body %v", b)
	}
	// The empty {{company}} is left out, as the Meta path does.
	want := `[map[text:Wei type:text] map[text:Offer type:text]]`
	if got := fmt.Sprint(tpl["components"].([]any)[0].(map[string]any)["parameters"]); got != want {
		t.Errorf("params %s", got)
	}
	if sent[1]["template"].(map[string]any)["language"] != "en" {
		t.Errorf("the language falls back to the setting: %v", sent[1])
	}
	if sent[0]["idempotencyKey"] == sent[1]["idempotencyKey"] || !strings.HasSuffix(sent[0]["idempotencyKey"].(string), "#0") || !strings.HasSuffix(sent[1]["idempotencyKey"].(string), "#1") {
		t.Errorf("each step has its own key: %v %v", sent[0]["idempotencyKey"], sent[1]["idempotencyKey"])
	}
}

func TestAutomationWhatsAppTemplateOnPersonalIsRefused(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_channel": "personal"}); err != nil {
		t.Fatal(err)
	}
	run := e.waAutomation(t, map[string]any{"type": "send_whatsapp", "template_name": "follow_up"})
	if len(wa.sends()) != 0 || len(wa.auth) != 0 {
		t.Fatal("nothing may be sent to the platform")
	}
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "failed" || !strings.Contains(e.scalar(t, `SELECT log::text FROM runs WHERE id = $1`, run).(string), "WABA") {
		t.Error("the run should fail with the reason")
	}
	// A text on the personal number is fine.
	if _, err := e.svc.SendWhatsApp(e.ctx, "0123456789", app.WhatsAppOpts{Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	if b := wa.sends()[0]; b["channelId"] != "personal" {
		t.Errorf("channel %v", b)
	}
}

// The platform refusing (opted out, 24 h window closed, channel disconnected) is final: logged
// with its message, never retried.
func TestAutomationWhatsAppRefusedIsFinal(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	wa.failNext(409)
	run := e.waAutomation(t, map[string]any{"type": "send_whatsapp", "text": "Hi"})
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "failed" {
		t.Fatal("run should have failed")
	}
	if log := e.scalar(t, `SELECT log::text FROM runs WHERE id = $1`, run).(string); !strings.Contains(log, "refused with 409") {
		t.Errorf("the platform's message belongs in the log: %s", log)
	}
	e.now = e.now.Add(48 * time.Hour)
	e.tick(t)
	if len(wa.sends()) != 0 || len(wa.auth) != 1 {
		t.Errorf("no retry: %d posts, %d accepted", len(wa.auth), len(wa.sends()))
	}
	if e.scalar(t, `SELECT count(*) FROM whatsapp WHERE direction = 'out'`).(int64) != 0 {
		t.Error("a refused message is not recorded as sent")
	}
}

func TestAutomationWhatsAppBusyIsRetried(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	wa.failNext(429, 503)
	run := e.waAutomation(t, map[string]any{"type": "send_whatsapp", "text": "Hi"})
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "active" || len(wa.sends()) != 0 {
		t.Fatal("a daily limit waits")
	}
	e.tick(t)
	if len(wa.auth) != 1 {
		t.Fatal("not before the hour is up")
	}
	e.now = e.now.Add(61 * time.Minute)
	e.tick(t) // 503: again later
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "active" || len(wa.sends()) != 0 {
		t.Fatal("a platform error waits too")
	}
	e.now = e.now.Add(61 * time.Minute)
	e.tick(t)
	sent := wa.sends()
	if len(sent) != 1 || sent[0]["idempotencyKey"] != "emailing:"+run+"#0" {
		t.Fatalf("sent %v", sent)
	}
	if e.scalar(t, `SELECT status FROM runs WHERE id = $1`, run) != "completed" {
		t.Error("run should complete after the retry")
	}
}

func TestAutomationNotifyWhatsAppAndTestSend(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	run := e.waAutomation(t, map[string]any{"type": "notify", "channel": "whatsapp", "whatsapp": "0198765432"})
	sent := wa.sends()
	if len(sent) != 1 || sent[0]["to"] != "60198765432" || sent[0]["ref"] != run || sent[0]["idempotencyKey"] == "" {
		t.Fatalf("notify %v", sent)
	}
	// The test send has no key and no reference.
	if _, err := e.svc.SendWhatsApp(e.ctx, "0198765432", app.WhatsAppOpts{Text: "test"}); err != nil {
		t.Fatal(err)
	}
	b := wa.sends()[1]
	if _, k := b["idempotencyKey"]; k || b["text"] != "test" {
		t.Errorf("test send %v", b)
	}
}

// A provider saved on purpose keeps being used.
func TestSavedChatDaddyProviderStillUsesChatDaddy(t *testing.T) {
	e := setup(t, true)
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	var mu sync.Mutex
	var paths []string
	cd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer cd.Close()
	old := app.ChatDaddyAPI
	app.ChatDaddyAPI = cd.URL
	defer func() { app.ChatDaddyAPI = old }()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"whatsapp_provider": "chatdaddy", "chatdaddy_token": "cdtok"}); err != nil {
		t.Fatal(err)
	}
	e.waAutomation(t, map[string]any{"type": "send_whatsapp", "text": "Hi"})
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 1 || paths[0] != "/messages/random/60123456789 Bearer cdtok" || len(wa.auth) != 0 {
		t.Errorf("chatdaddy %v, platform posts %d", paths, len(wa.auth))
	}
}
