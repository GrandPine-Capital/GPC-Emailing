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

const keycloakSecret = "test-keycloak-secret"

func signKeycloak(body string) string {
	m := hmac.New(sha256.New, []byte(keycloakSecret))
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))
}

func keycloakBody(typ, id string) string {
	return `{"type":"` + typ + `","id":"` + id + `","occurred_at":"2026-11-10T02:00:00Z","realm":"valuefarm","realm_name":"ValueFarm",` +
		`"user":{"id":"u-42","username":"lim","email":"Lim@Example.com","first_name":"Lim","last_name":"Wei","phone":"012-345 6789"},` +
		`"link":"https://sso.test/realms/valuefarm/login-actions/action-token?key=abc&client_id=web",` +
		`"expires_in":"12 hours","expires_at":"2026-11-10T14:00:00Z","required_actions":"Update Password"}`
}

func (e *env) keycloakEvent(t *testing.T, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandleKeycloakEvent(e.ctx, signKeycloak(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e *env) keycloakRows(t *testing.T) (email, whatsapp []app.TxnRow) {
	t.Helper()
	rows, err := e.svc.Transactionals(e.ctx, "keycloak", "u-42", "", "", 0)
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

// Each of Keycloak's three e-mails goes out from its own template with Keycloak's link, and is
// then this service's ("handled"); a repeated event sends nothing new.
func TestKeycloakEmails(t *testing.T) {
	e := setup(t, true)
	e.svc.KeycloakEventSecret = keycloakSecret
	for i, c := range []struct{ typ, wording string }{
		{"keycloak.execute_actions", "Reset My Password"},
		{"keycloak.password_reset", "someone asked to reset the password"},
		{"keycloak.verify_email", "Confirm My Email"},
	} {
		body := keycloakBody(c.typ, "evt-"+c.typ)
		out := e.keycloakEvent(t, body)
		if out["handled"] != true || out["status"] != "sent" || out["created"] != true {
			t.Fatalf("%s: %v", c.typ, out)
		}
		msg := decoded(e.ses.since(i)[0])
		for _, want := range []string{
			"<lim@example.com>", c.wording,
			`href="https://sso.test/realms/valuefarm/login-actions/action-token?key=abc&client_id=web"`, "12 hours",
		} {
			if !strings.Contains(msg, want) {
				t.Errorf("%s mail lacks %q", c.typ, want)
			}
		}
		if !strings.Contains(msg, "Subject:") || strings.Contains(msg, "{{") {
			t.Errorf("%s mail has an unmerged tag or no subject", c.typ)
		}
		for _, unwanted := range []string{"List-Unsubscribe", "/o?t=", "/r?t="} {
			if strings.Contains(msg, unwanted) {
				t.Errorf("%s mail carries %q", c.typ, unwanted)
			}
		}
		if again := e.keycloakEvent(t, body); again["created"] != false || again["handled"] != true || e.ses.count() != i+1 {
			t.Fatalf("%s retry: %v, sent %d", c.typ, again, e.ses.count())
		}
	}
	if rows, _ := e.keycloakRows(t); len(rows) != 3 {
		t.Fatalf("rows = %d", len(rows))
	}
}

// Whenever the e-mail is not sent here, the answer says so and Keycloak sends its own; the row
// is closed, so the worker never sends a second e-mail later.
func TestKeycloakLeftToKeycloak(t *testing.T) {
	body := keycloakBody("keycloak.password_reset", "evt-1")

	t.Run("turned off", func(t *testing.T) {
		e := setup(t, true)
		e.svc.KeycloakEventSecret = keycloakSecret
		if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"keycloak.password_reset": map[string]any{"enabled": false}}}); err != nil {
			t.Fatal(err)
		}
		if out := e.keycloakEvent(t, body); out["handled"] != false || e.ses.count() != 0 {
			t.Fatalf("off: %v, sent %d", out, e.ses.count())
		}
		if rows, _ := e.keycloakRows(t); len(rows) != 0 {
			t.Fatalf("off: rows %+v", rows)
		}
	})

	t.Run("no SES", func(t *testing.T) {
		e := setup(t, false)
		e.svc.KeycloakEventSecret = keycloakSecret
		out := e.keycloakEvent(t, body)
		if out["handled"] != false || out["status"] != "skipped" {
			t.Fatalf("no SES: %v", out)
		}
		rows, _ := e.keycloakRows(t)
		if len(rows) != 1 || rows[0].Status != "skipped" || rows[0].Error == nil || !strings.Contains(*rows[0].Error, "left to Keycloak") {
			t.Fatalf("no SES: rows %+v", rows)
		}
		e.now = e.now.Add(3 * 60 * 60 * 1e9)
		e.tick(t)
		if rows, _ = e.keycloakRows(t); rows[0].Status != "skipped" {
			t.Fatalf("the worker picked it up: %+v", rows[0])
		}
	})

	t.Run("dry run", func(t *testing.T) {
		e := setup(t, true)
		e.svc.KeycloakEventSecret = keycloakSecret
		if err := e.svc.UpdateSettings(e.ctx, map[string]any{"dry_run": true}); err != nil {
			t.Fatal(err)
		}
		out := e.keycloakEvent(t, body)
		rows, _ := e.keycloakRows(t)
		if out["handled"] != false || len(rows) != 1 || rows[0].Status != "sent" || !rows[0].DryRun {
			t.Fatalf("dry run: %v, rows %+v", out, rows)
		}
	})

	t.Run("other events and no address", func(t *testing.T) {
		e := setup(t, true)
		e.svc.KeycloakEventSecret = keycloakSecret
		if out := e.keycloakEvent(t, keycloakBody("keycloak.org_invite", "evt-2")); out["handled"] != false {
			t.Fatalf("unknown type: %v", out)
		}
		// A payment event type is not Keycloak's to send.
		if out := e.keycloakEvent(t, keycloakBody("payment.succeeded", "evt-3")); out["handled"] != false {
			t.Fatalf("payment type: %v", out)
		}
		if out := e.keycloakEvent(t, strings.Replace(body, "Lim@Example.com", "", 1)); out["handled"] != false || e.ses.count() != 0 {
			t.Fatalf("no address: %v", out)
		}
	})
}

func TestKeycloakEventGuards(t *testing.T) {
	e := setup(t, true)
	body := keycloakBody("keycloak.password_reset", "evt-1")
	if _, err := e.svc.HandleKeycloakEvent(e.ctx, signKeycloak(body), []byte(body)); !errors.Is(err, app.ErrKeycloakHookOff) {
		t.Fatalf("without a secret: %v", err)
	}
	e.svc.KeycloakEventSecret = keycloakSecret
	if _, err := e.svc.HandleKeycloakEvent(e.ctx, "00"+signKeycloak(body)[2:], []byte(body)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	// Payment's secret does not open the Keycloak hook.
	e.svc.PaymentEventSecret = paymentSecret
	if _, err := e.svc.HandleKeycloakEvent(e.ctx, sign(body), []byte(body)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("payment secret: %v", err)
	}
	var ue app.UserError
	bad := strings.Replace(body, "https://sso.test", "javascript:alert(1)//", 1)
	if _, err := e.svc.HandleKeycloakEvent(e.ctx, signKeycloak(bad), []byte(bad)); !errors.As(err, &ue) {
		t.Fatalf("a link that is not http(s): %v", err)
	}
	if _, err := e.svc.HandleKeycloakEvent(e.ctx, signKeycloak(`{"type":"keycloak.password_reset"}`), []byte(`{"type":"keycloak.password_reset"}`)); !errors.As(err, &ue) {
		t.Fatalf("no id: %v", err)
	}
	if e.ses.count() != 0 {
		t.Fatalf("sent %d", e.ses.count())
	}
}

// The WhatsApp notice: off until ticked; then queued with the answer (Keycloak is not kept
// waiting) and sent by the worker, to the user's number in international form, without the link.
func TestKeycloakWhatsAppNotice(t *testing.T) {
	e := setup(t, true)
	e.svc.KeycloakEventSecret = keycloakSecret
	wa := newFakeWA(t)
	e.connectWA(t, wa)

	out := e.keycloakEvent(t, keycloakBody("keycloak.password_reset", "evt-1"))
	if out["whatsapp"] != nil || out["handled"] != true {
		t.Fatalf("whatsapp off: %v", out)
	}

	e.whatsappFor(t, "keycloak.password_reset", map[string]any{"enabled": true, "channel": "personal", "kind": "text"}) // the default wording
	out = e.keycloakEvent(t, keycloakBody("keycloak.password_reset", "evt-2"))
	if w, _ := out["whatsapp"].(map[string]any); out["handled"] != true || w == nil || w["status"] != "queued" || len(wa.sends()) != 0 {
		t.Fatalf("queued: %v, %d sends", out, len(wa.sends()))
	}
	e.tick(t)
	sends := wa.sends()
	if len(sends) != 1 || sends[0]["to"] != "60123456789" {
		t.Fatalf("sends = %v", sends)
	}
	text, _ := sends[0]["text"].(string)
	if !strings.HasPrefix(text, "Hi Lim, we have just e-mailed you a link to reset your ValueFarm password. It works for 12 hours.") {
		t.Fatalf("text = %q", text)
	}
	_, rows := e.keycloakRows(t)
	if len(rows) != 1 || rows[0].Status != "sent" {
		t.Fatalf("rows = %+v", rows)
	}
	if _, ok := rows[0].Vars["action_url"]; ok {
		t.Fatal("the WhatsApp row holds the link")
	}

	// Wording that asks for the link gets nothing: the link is not among the notice's values.
	e.whatsappFor(t, "keycloak.password_reset", map[string]any{"enabled": true, "channel": "personal", "kind": "text", "text": "Hi {{first_name}}\nReset here: {{action_url}}"})
	e.keycloakEvent(t, keycloakBody("keycloak.password_reset", "evt-3"))
	e.tick(t)
	if sends = wa.sends(); len(sends) != 2 || sends[1]["text"] != "Hi Lim" {
		t.Fatalf("link wording: %v", sends)
	}

	// No phone on the account: the e-mail goes, the notice does not.
	out = e.keycloakEvent(t, strings.Replace(keycloakBody("keycloak.password_reset", "evt-4"), "012-345 6789", "", 1))
	if w, _ := out["whatsapp"].(map[string]any); out["handled"] != true || w == nil || w["ignored"] == nil {
		t.Fatalf("no phone: %v", out)
	}
}

// The Transactional page lists the Keycloak e-mails with their templates and WhatsApp block.
func TestKeycloakTransactionalConfig(t *testing.T) {
	e := setup(t, true)
	cfg, err := e.svc.TransactionalConfig(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg["keycloak_hook"] != false {
		t.Fatalf("keycloak_hook = %v", cfg["keycloak_hook"])
	}
	n := 0
	for _, ev := range cfg["events"].([]map[string]any) {
		if ev["source"] != "keycloak" {
			continue
		}
		n++
		w, _ := ev["whatsapp"].(map[string]any)
		if ev["enabled"] != true || ev["default_template_id"] == "" || ev["template_id"] != ev["default_template_id"] || w == nil || w["enabled"] != false ||
			strings.Contains(w["default_text"].(string), "action_url") {
			t.Fatalf("%v: %v", ev["event"], ev)
		}
	}
	if n != 3 {
		t.Fatalf("keycloak events = %d", n)
	}
}
