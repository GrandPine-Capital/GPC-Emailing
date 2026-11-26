package app_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

const waHookSecret = "test-gpc-wa-secret"

func signWA(body string) string {
	m := hmac.New(sha256.New, []byte(waHookSecret))
	m.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

func (e *env) waHookOn(t *testing.T) {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"gpc_whatsapp_webhook_secret": waHookSecret, "default_country_code": "60"}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) waHook(t *testing.T, event, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandleWhatsAppHook(e.ctx, event, signWA(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func waReceived(id, phone, text string) string {
	return fmt.Sprintf(`{"id":"d-%s","event":"message.received","tenantId":"t","timestamp":"2026-11-26T08:00:00.000Z","data":{"message":{"id":"%s","direction":"in","type":"text","text":%q,"phone":"%s"},"contact":{"phone":"%s","name":"Lim Wei"},"conversationId":"c"}}`, id, id, text, phone, phone)
}

func waStatus(id, status, errText string) string {
	return fmt.Sprintf(`{"id":"d","event":"message.status","data":{"messageId":"%s","status":"%s","error":%q,"phone":"60123456789"}}`, id, status, errText)
}

func TestWhatsAppHookGuards(t *testing.T) {
	e := setup(t, true)
	body := waReceived("m1", "60123456789", "hi")
	if _, err := e.svc.HandleWhatsAppHook(e.ctx, "message.received", signWA(body), []byte(body)); !errors.Is(err, app.ErrWhatsAppHookOff) {
		t.Fatalf("without a secret: %v", err)
	}
	e.waHookOn(t)
	bare := strings.TrimPrefix(signWA(body), "sha256=")
	for name, sig := range map[string]string{"bad": "sha256=00" + signWA(body)[9:], "no prefix": bare, "missing": "", "wrong secret": "sha256=" + strings.Repeat("0", 64)} {
		if _, err := e.svc.HandleWhatsAppHook(e.ctx, "message.received", sig, []byte(body)); !errors.Is(err, app.ErrBadSignature) {
			t.Fatalf("%s signature: %v", name, err)
		}
	}
	if _, err := e.svc.HandleWhatsAppHook(e.ctx, "", signWA("nope"), []byte("nope")); err == nil || errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("not JSON must be a 400-type error: %v", err)
	}
	if n := e.scalar(t, `SELECT count(*) FROM replies`); n.(int64) != 0 {
		t.Fatalf("rejected deliveries wrote %v replies", n)
	}
}

// A reply is recorded once however often it is delivered, fires whatsapp_received and stops a
// sequence that has a stop_if: replied step.
func TestWhatsAppHookReceived(t *testing.T) {
	e := setup(t, true)
	e.waHookOn(t)
	if _, err := e.svc.CreateContact(e.ctx, app.ContactInput{Email: "lim@example.com", FirstName: "Lim", Phone: "012-345 6789"}); err != nil {
		t.Fatal(err)
	}
	seq, err := e.svc.CreateAutomation(e.ctx, map[string]any{"name": "Nurture", "trigger_type": "manual", "status": "active", "steps": []any{
		map[string]any{"type": "wait", "amount": 2, "unit": "days"},
		map[string]any{"type": "stop_if", "condition": "replied"},
		map[string]any{"type": "add_tag", "tag": "nurtured"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := e.svc.CreateAutomation(e.ctx, map[string]any{"name": "On reply", "trigger_type": "whatsapp_received", "status": "active", "steps": []any{
		map[string]any{"type": "add_tag", "tag": "wa-replied"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := e.svc.Enroll(e.ctx, seq["id"].(string), []string{"lim@example.com"}, ""); err != nil || n != 1 {
		t.Fatalf("enroll %d %v", n, err)
	}
	e.tick(t)

	body := waReceived("wamid.ABC", "+60 12-345 6789", "Yes please")
	if out := e.waHook(t, "message.received", body); out["ok"] != true || out["ignored"] != nil {
		t.Fatalf("received: %v", out)
	}
	e.waHook(t, "message.received", body) // the same delivery again
	if n := e.scalar(t, `SELECT count(*) FROM replies WHERE channel = 'whatsapp'`); n.(int64) != 1 {
		t.Fatalf("replies = %v, want 1", n)
	}
	if e.scalar(t, `SELECT contact_id FROM replies WHERE channel = 'whatsapp'`) != "lim@example.com" || e.scalar(t, `SELECT body FROM replies WHERE channel = 'whatsapp'`) != "Yes please" {
		t.Error("the reply must belong to the contact matched by phone_key")
	}
	if n := e.scalar(t, `SELECT count(*) FROM contacts`); n.(int64) != 1 {
		t.Errorf("contacts = %v: the number should have matched the existing contact", n)
	}
	e.tick(t)
	if n := e.scalar(t, `SELECT count(*) FROM runs WHERE automation_id = $1`, listener["id"]); n.(int64) != 1 {
		t.Errorf("whatsapp_received fired %v times, want once", n)
	}
	e.now = e.now.Add(49 * time.Hour)
	e.tick(t)
	e.tick(t)
	if tags := e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'lim@example.com'`).(string); strings.Contains(tags, "nurtured") || !strings.Contains(tags, "wa-replied") {
		t.Errorf("the sequence should stop on the reply; tags = %q", tags)
	}
	if st := e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1`, seq["id"]); st == "active" {
		t.Errorf("sequence run status = %v", st)
	}

	// An unknown number follows the ChatDaddy path: a contact with source whatsapp.
	e.waHook(t, "message.received", waReceived("wamid.NEW", "60199998888", "Hello"))
	if e.scalar(t, `SELECT source FROM contacts WHERE phone_key = '60199998888'`) != "whatsapp" {
		t.Error("an unknown number should become a whatsapp contact")
	}
}

func (e *env) sentWhatsAppRow(t *testing.T, wa *fakeWA) (id, messageID string) {
	t.Helper()
	e.svc.PaymentEventSecret = paymentSecret
	e.connectWA(t, wa)
	e.whatsappFor(t, "payment.pending", map[string]any{"enabled": true, "channel": "personal", "kind": "text"})
	e.paymentEvent(t, bankPending)
	_, rows := e.txnRows(t, "Pay9")
	if len(rows) != 1 || rows[0].Status != "sent" || rows[0].ProviderID == nil {
		t.Fatalf("setup: %+v", rows)
	}
	return rows[0].ID, *rows[0].ProviderID
}

func TestWhatsAppHookStatus(t *testing.T) {
	e := setup(t, true)
	e.waHookOn(t)
	wa := newFakeWA(t)
	_, mid := e.sentWhatsAppRow(t, wa)

	e.waHook(t, "message.status", waStatus(mid, "delivered", ""))
	e.waHook(t, "message.status", waStatus(mid, "read", ""))
	if _, rows := e.txnRows(t, "Pay9"); rows[0].Status != "sent" || rows[0].Error != nil {
		t.Fatalf("delivered/read must leave the row alone: %+v", rows[0])
	}

	e.waHook(t, "message.status", waStatus(mid, "failed", "Re-engagement message: 24 h window closed"))
	_, rows := e.txnRows(t, "Pay9")
	if rows[0].Status != "failed" || rows[0].Error == nil || !strings.Contains(*rows[0].Error, "24 h window closed") {
		t.Fatalf("failed: %+v", rows[0])
	}
	// Nothing is re-queued or re-sent by itself.
	e.now = e.now.Add(3 * time.Hour)
	e.tick(t)
	if _, rows = e.txnRows(t, "Pay9"); len(rows) != 1 || rows[0].Status != "failed" || len(wa.sends()) != 1 {
		t.Fatalf("after a tick: %+v, %d sends", rows, len(wa.sends()))
	}
}

func TestWhatsAppHookStatusAutomationAndUnknown(t *testing.T) {
	e := setup(t, true)
	e.waHookOn(t)
	if _, err := e.svc.CreateContact(e.ctx, app.ContactInput{Email: "lim@example.com", Phone: "012-345 6789"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Pool.Exec(e.ctx, `INSERT INTO whatsapp (id, contact_id, phone, direction, text, created_at) VALUES ('wa-wamid.AUTO','lim@example.com','60123456789','out','Hi',now())`); err != nil {
		t.Fatal(err)
	}
	if out := e.waHook(t, "message.status", waStatus("wamid.AUTO", "failed", "boom")); out["ok"] != true || out["ignored"] != nil {
		t.Fatalf("automation send: %v", out)
	}
	for _, body := range []string{waStatus("wamid.NOPE", "failed", "x"), `{"event":"message.status","data":{}}`} {
		if out := e.waHook(t, "message.status", body); out["ok"] != true || out["ignored"] != "unknown message" {
			t.Fatalf("unknown id: %v", out)
		}
	}
	for _, ev := range []string{"ping", "contact.updated", "message.sent"} {
		body := fmt.Sprintf(`{"id":"x","event":"%s","data":{}}`, ev)
		if out := e.waHook(t, ev, body); out["ok"] != true || out["ignored"] == nil {
			t.Fatalf("%s: %v", ev, out)
		}
	}
}
