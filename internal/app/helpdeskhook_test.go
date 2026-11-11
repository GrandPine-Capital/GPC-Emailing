package app_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

const helpdeskSecret = "test-helpdesk-secret"

func signHelpdesk(body string) string {
	m := hmac.New(sha256.New, []byte(helpdeskSecret))
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))
}

const resetEvent = `{"type":"helpdesk.password_reset","id":"evt-1","occurred_at":"2026-11-11T09:00:00Z",` +
	`"customer":{"name":"Aisyah Rahman","email":"Aisyah@Example.com"},` +
	`"reset_url":"https://helpdesk.test/reset-password?token=abc","expires_at":"2026-11-11T10:00:00Z"}`

func (e *env) helpdeskEvent(t *testing.T, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandleHelpdeskEvent(e.ctx, signHelpdesk(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestHelpdeskPasswordReset(t *testing.T) {
	e := setup(t, true)
	e.svc.HelpdeskEventSecret = helpdeskSecret
	out := e.helpdeskEvent(t, resetEvent)
	if out["status"] != "sent" || out["created"] != true {
		t.Fatalf("first event: %v", out)
	}
	msg := decoded(e.ses.since(0)[0])
	for _, want := range []string{
		"To: \"Aisyah Rahman\" <aisyah@example.com>",
		"Subject: Reset your GrandPine Helpdesk password",
		"Hi Aisyah,", `href="https://helpdesk.test/reset-password?token=abc"`, "11 Nov 2026, 6:00 PM",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("reset mail lacks %q", want)
		}
	}
	for _, unwanted := range []string{"List-Unsubscribe", "/o?t=", "/r?t="} {
		if strings.Contains(msg, unwanted) {
			t.Errorf("reset mail carries %q", unwanted)
		}
	}
	// The same event again (a retry): sent once.
	if out := e.helpdeskEvent(t, resetEvent); out["created"] != false || e.ses.count() != 1 {
		t.Fatalf("retry: %v, sent %d", out, e.ses.count())
	}
	rows, err := e.svc.Transactionals(e.ctx, "helpdesk", "evt-1", "", "", 0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows: %+v %v", rows, err)
	}
}

func TestHelpdeskEventGuards(t *testing.T) {
	e := setup(t, true)
	if _, err := e.svc.HandleHelpdeskEvent(e.ctx, signHelpdesk(resetEvent), []byte(resetEvent)); !errors.Is(err, app.ErrHelpdeskHookOff) {
		t.Fatalf("without a secret: %v", err)
	}
	e.svc.HelpdeskEventSecret = helpdeskSecret
	if _, err := e.svc.HandleHelpdeskEvent(e.ctx, "00"+signHelpdesk(resetEvent)[2:], []byte(resetEvent)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	// Payment's secret does not open the Helpdesk hook.
	e.svc.PaymentEventSecret = paymentSecret
	if _, err := e.svc.HandleHelpdeskEvent(e.ctx, sign(resetEvent), []byte(resetEvent)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("payment secret: %v", err)
	}
	// A payment event type on the Helpdesk hook is ignored.
	payType := strings.Replace(resetEvent, "helpdesk.password_reset", "payment.succeeded", 1)
	if out := e.helpdeskEvent(t, payType); out["ignored"] == nil {
		t.Fatalf("payment type: %v", out)
	}
	noEmail := strings.Replace(resetEvent, "Aisyah@Example.com", "", 1)
	if out := e.helpdeskEvent(t, noEmail); out["ignored"] == nil {
		t.Fatalf("no e-mail: %v", out)
	}
	badURL := strings.Replace(resetEvent, "https://helpdesk.test", "javascript:alert(1)//", 1)
	var ue app.UserError
	if _, err := e.svc.HandleHelpdeskEvent(e.ctx, signHelpdesk(badURL), []byte(badURL)); !errors.As(err, &ue) {
		t.Fatalf("bad reset_url: %v", err)
	}
	// Turned off on the Transactional page.
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"helpdesk.password_reset": map[string]any{"enabled": false}}}); err != nil {
		t.Fatal(err)
	}
	if out := e.helpdeskEvent(t, resetEvent); out["ignored"] == nil {
		t.Fatalf("turned off: %v", out)
	}
	if e.ses.count() != 0 {
		t.Fatalf("sent %d, want 0", e.ses.count())
	}
}
