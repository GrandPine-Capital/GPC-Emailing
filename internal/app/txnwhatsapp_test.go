package app_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

// fakeWA is GPC-WhatsApp's public API as payment WhatsApp uses it: POST /api/v1/messages (with
// its idempotency keys) and GET /api/v1/channels.
type fakeWA struct {
	mu     sync.Mutex
	sent   []map[string]any // each accepted POST /messages body
	auth   []string
	fail   []int // statuses to answer the next sends with, in order
	byKey  map[string]string
	server *httptest.Server
}

func newFakeWA(t *testing.T) *fakeWA {
	f := &fakeWA{byKey: map[string]string{}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/channels":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{
				map[string]any{"id": "ch-waba", "type": "waba", "name": "GrandPine Official", "phone_number": "+60 3-1234 5678", "status": "connected"},
				map[string]any{"id": "ch-p", "type": "personal", "name": "Sales", "phone_number": "+60 12-000 0000", "status": "connected"},
			}})
		case r.Method == "POST" && r.URL.Path == "/api/v1/messages":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.auth = append(f.auth, r.Header.Get("Authorization"))
			if len(f.fail) > 0 {
				code := f.fail[0]
				f.fail = f.fail[1:]
				w.WriteHeader(code)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "x", "message": fmt.Sprintf("refused with %d", code)}})
				return
			}
			key, _ := body["idempotencyKey"].(string)
			if id, ok := f.byKey[key]; ok && key != "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"messageId": id, "status": "queued", "duplicate": true})
				return
			}
			f.sent = append(f.sent, body)
			id := fmt.Sprintf("wa-%d", len(f.sent))
			f.byKey[key] = id
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"messageId": id, "conversationId": "c__" + fmt.Sprint(body["to"]), "status": "queued"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeWA) sends() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.sent...)
}

func (f *fakeWA) failNext(codes ...int) {
	f.mu.Lock()
	f.fail = append(f.fail, codes...)
	f.mu.Unlock()
}

func (e *env) connectWA(t *testing.T, f *fakeWA) {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_url": f.server.URL + "/", "gpc_whatsapp_key": "gpc_live_test"}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) whatsappFor(t *testing.T, event string, wa map[string]any) {
	t.Helper()
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{event: map[string]any{"enabled": true, "whatsapp": wa}}}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) txnRows(t *testing.T, reference string) (email, whatsapp []app.TxnRow) {
	t.Helper()
	rows, err := e.svc.Transactionals(e.ctx, "payment", reference, "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.Channel == "whatsapp" {
			whatsapp = append(whatsapp, r)
		} else {
			email = append(email, r)
		}
	}
	return email, whatsapp
}

const bankPending = `{"type":"payment.pending","payment_id":"Pay9","occurred_at":"2026-11-10T01:00:00Z","customer":{"name":"Lim Wei","phone":"012-345 6789","email":"lim@example.com"},` +
	`"product":"Annual plan","amount":99.00,"currency":"MYR","payment_method":"bank-transfer","reference":"bank_transfer:GP-7Q2",` +
	`"instructions_url":"https://pay.test/pay-return?txn=Pay9","expires_at":"2026-11-13T15:59:00Z","payment_reference":"GP-7Q2",` +
	`"bank_account":{"bank_name":"Maybank","account_number":"5140 1234 5678","account_name":"GrandPine Capital Sdn Bhd"}}`

// Nothing changes until staff switch WhatsApp on for an event: the CRM may still be sending its own.
func TestPaymentWhatsAppOffByDefault(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	out := e.paymentEvent(t, bankPending)
	if len(wa.sends()) != 0 || out["whatsapp"] != nil || e.ses.count() != 1 {
		t.Fatalf("whatsapp off: %v, %d whatsapp sends, %d e-mails", out, len(wa.sends()), e.ses.count())
	}
}

// Bank-transfer instructions as a personal-number text: the account, the reference and the
// pay-by date, to the buyer's number in international form, sent once.
func TestPaymentWhatsAppText(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"}) // the default wording

	out := e.paymentEvent(t, bankPending)
	sends := wa.sends()
	if len(sends) != 1 || e.ses.count() != 1 {
		t.Fatalf("sent %d whatsapp, %d e-mail: %v", len(sends), e.ses.count(), out)
	}
	got := sends[0]
	if got["channelId"] != "personal" || got["to"] != "60123456789" || got["ref"] != "Pay9" || got["idempotencyKey"] == "" || got["template"] != nil {
		t.Fatalf("request = %v", got)
	}
	if wa.auth[0] != "Bearer gpc_live_test" {
		t.Fatalf("authorization = %q", wa.auth[0])
	}
	text, _ := got["text"].(string)
	for _, want := range []string{"Hi Lim,", "RM 99.00", "Annual plan", "Maybank", "GrandPine Capital Sdn Bhd", "5140 1234 5678", "GP-7Q2", "13 Nov 2026, 11:59 PM", "https://pay.test/pay-return?txn=Pay9"} {
		if !strings.Contains(text, want) {
			t.Errorf("text lacks %q:\n%s", want, text)
		}
	}
	// A line whose merge tags are all empty is left out, rather than sent as "DuitNow ID: ".
	if strings.Contains(text, "DuitNow") || strings.Contains(text, "{{") {
		t.Errorf("text keeps an empty line or a tag:\n%s", text)
	}
	if w, ok := out["whatsapp"].(map[string]any); !ok || w["status"] != "sent" {
		t.Fatalf("result = %v", out)
	}
	_, rows := e.txnRows(t, "Pay9")
	if len(rows) != 1 || rows[0].ToPhone != "60123456789" || rows[0].Status != "sent" || rows[0].Subject == "" || rows[0].SentAt == nil {
		t.Fatalf("whatsapp row = %+v", rows)
	}

	// Payment retries the event: nothing is sent twice.
	e.paymentEvent(t, bankPending)
	if len(wa.sends()) != 1 || e.ses.count() != 1 {
		t.Fatalf("after a retried event: %d whatsapp, %d e-mail", len(wa.sends()), e.ses.count())
	}
	// Staff resend: a new message, under a new key.
	if st, err := e.svc.ResendTransactional(e.ctx, rows[0].ID); err != nil || st != "sent" || len(wa.sends()) != 2 {
		t.Fatalf("resend: %s %v, %d sends", st, err, len(wa.sends()))
	}
	if a, b := wa.sends()[0]["idempotencyKey"], wa.sends()[1]["idempotencyKey"]; a == b {
		t.Fatalf("resend reused the key %v", a)
	}
}

// A receipt from the WABA number: an approved template, its body parameters filled in order.
func TestPaymentWhatsAppTemplate(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.succeeded", map[string]any{"enabled": true, "channel": "ch-waba", "kind": "template",
		"template": "payment_receipt", "language": "en", "params": []any{"{{first_name}}", "{{amount}}", "{{item}}", "{{duitnow_id}}"}})
	e.paymentEvent(t, succeeded)
	sends := wa.sends()
	if len(sends) != 1 {
		t.Fatalf("sent %d", len(sends))
	}
	got := sends[0]
	if got["channelId"] != "ch-waba" || got["to"] != "60123456789" || got["text"] != nil {
		t.Fatalf("request = %v", got)
	}
	raw, _ := json.Marshal(got["template"])
	want := `{"components":[{"parameters":[{"text":"Aisyah","type":"text"},{"text":"RM 1,234.50","type":"text"},` +
		`{"text":"Workshop: Reading Annual Reports","type":"text"},{"text":"-","type":"text"}],"type":"body"}],"language":"en","name":"payment_receipt"}`
	if string(raw) != want {
		t.Fatalf("template = %s\nwant       %s", raw, want)
	}
}

// A platform that is down is retried by the worker under the same key (so a send it took but
// did not answer goes once), and WhatsApp does not wait for SES.
func TestPaymentWhatsAppRetry(t *testing.T) {
	e := setup(t, false) // no SES
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text", "text": "Hi {{first_name}}, pay {{amount}}."})
	wa.failNext(http.StatusServiceUnavailable)

	out := e.paymentEvent(t, bankPending)
	if w, _ := out["whatsapp"].(map[string]any); w == nil || w["status"] != "queued" {
		t.Fatalf("result = %v", out)
	}
	_, rows := e.txnRows(t, "Pay9")
	if len(rows) != 1 || rows[0].Status != "queued" || rows[0].Attempts != 1 || rows[0].Error == nil || !strings.Contains(*rows[0].Error, "503") {
		t.Fatalf("after a 503: %+v", rows)
	}
	e.now = e.now.Add(2 * time.Minute)
	e.tick(t)
	sends := wa.sends()
	if len(sends) != 1 || sends[0]["text"] != "Hi Lim, pay RM 99.00." {
		t.Fatalf("retried sends = %v", sends)
	}
	if _, rows = e.txnRows(t, "Pay9"); rows[0].Status != "sent" || rows[0].Error != nil {
		t.Fatalf("after the retry: %+v", rows[0])
	}
}

// A request the platform refuses as wrong (bad key, unknown channel) fails at once: retrying
// would not change it.
func TestPaymentWhatsAppRefused(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"})
	wa.failNext(http.StatusBadRequest)
	e.paymentEvent(t, bankPending)
	if _, rows := e.txnRows(t, "Pay9"); len(rows) != 1 || rows[0].Status != "failed" || !strings.Contains(*rows[0].Error, "400") {
		t.Fatalf("after a 400: %+v", rows)
	}
}

// Switched on before the platform is connected: kept, and sent once it is, without using up
// attempts while it waits.
func TestPaymentWhatsAppWaitsForConnection(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"})
	e.paymentEvent(t, bankPending)
	_, rows := e.txnRows(t, "Pay9")
	if len(rows) != 1 || rows[0].Status != "queued" || rows[0].Attempts != 0 || !strings.Contains(*rows[0].Error, "Settings") {
		t.Fatalf("before connecting: %+v", rows)
	}
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.now = e.now.Add(61 * time.Minute)
	e.tick(t)
	if len(wa.sends()) != 1 {
		t.Fatalf("after connecting: %d sends", len(wa.sends()))
	}
}

// No phone on the order: the e-mail still goes, WhatsApp says why it did not.
func TestPaymentWhatsAppNoPhone(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"})
	out := e.paymentEvent(t, strings.Replace(bankPending, "012-345 6789", "", 1))
	w, _ := out["whatsapp"].(map[string]any)
	if w == nil || w["ignored"] == nil || len(wa.sends()) != 0 || e.ses.count() != 1 {
		t.Fatalf("no phone: %v, %d sends", out, len(wa.sends()))
	}
	// And an order with a phone but no e-mail still gets its WhatsApp.
	other := strings.NewReplacer("Pay9", "Pay10", "lim@example.com", "").Replace(bankPending)
	if out := e.paymentEvent(t, other); out["ignored"] == nil || len(wa.sends()) != 1 {
		t.Fatalf("no e-mail: %v, %d sends", out, len(wa.sends()))
	}
}

// Dry-run mode records the WhatsApp without sending it.
func TestPaymentWhatsAppDryRun(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"dry_run": true}); err != nil {
		t.Fatal(err)
	}
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"})
	e.paymentEvent(t, bankPending)
	if _, rows := e.txnRows(t, "Pay9"); len(wa.sends()) != 0 || len(rows) != 1 || rows[0].Status != "sent" || !rows[0].DryRun {
		t.Fatalf("dry run: %d sends, %+v", len(wa.sends()), rows)
	}
}

// The Transactional page: WhatsApp per payment and Keycloak event (not for the Helpdesk e-mail), the
// default wording, the numbers to choose from, and what it refuses.
func TestTransactionalWhatsAppConfig(t *testing.T) {
	e := setup(t, true)
	cfg, err := e.svc.TransactionalConfig(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg["whatsapp_connected"] != false {
		t.Fatalf("connected before set up: %v", cfg["whatsapp_connected"])
	}
	for _, ev := range cfg["events"].([]map[string]any) {
		w, _ := ev["whatsapp"].(map[string]any)
		switch ev["source"] {
		case "payment", "keycloak":
			if w == nil || w["enabled"] != false || w["channel"] != "personal" || w["kind"] != "text" || !strings.Contains(fmt.Sprint(w["default_text"]), "{{") {
				t.Errorf("%s whatsapp = %v", ev["event"], w)
			}
		default:
			if w != nil {
				t.Errorf("%s offers WhatsApp: %v", ev["event"], w)
			}
		}
	}

	var ue app.UserError
	err = e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"payment.succeeded": map[string]any{"whatsapp": map[string]any{"enabled": true, "channel": "ch-waba", "kind": "template"}}}})
	if !errors.As(err, &ue) {
		t.Fatalf("template without a name: %v", err)
	}
	err = e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"payment.succeeded": map[string]any{"whatsapp": map[string]any{"enabled": true, "channel": "personal", "kind": "text", "text": strings.Repeat("x", 4001)}}}})
	if !errors.As(err, &ue) {
		t.Fatalf("over-long text: %v", err)
	}
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_url": "ftp://x"}); !errors.As(err, &ue) {
		t.Fatalf("bad platform address: %v", err)
	}

	wa := newFakeWA(t)
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.refunded", map[string]any{"enabled": true, "channel": "ch-p", "kind": "text", "text": "Refunded {{amount}}"})
	cfg, _ = e.svc.TransactionalConfig(e.ctx)
	if cfg["whatsapp_connected"] != true {
		t.Fatal("not connected after set up")
	}
	refund := cfg["events"].([]map[string]any)[2]["whatsapp"].(map[string]any)
	if refund["enabled"] != true || refund["channel"] != "ch-p" || refund["text"] != "Refunded {{amount}}" {
		t.Fatalf("saved refund whatsapp = %v", refund)
	}
	chans, err := e.svc.WhatsAppChannels(e.ctx)
	if err != nil || len(chans) != 2 || chans[0]["id"] != "ch-waba" || chans[0]["type"] != "waba" {
		t.Fatalf("channels = %v %v", chans, err)
	}
	// The key is a secret: only admins read it back, and the URL is kept without its slash.
	view, _ := e.svc.SettingsView(e.ctx, false)
	if view["gpc_whatsapp_key"] != "" || view["gpc_whatsapp_url"] != wa.server.URL {
		t.Fatalf("settings for an editor: key %q url %q", view["gpc_whatsapp_key"], view["gpc_whatsapp_url"])
	}
}
