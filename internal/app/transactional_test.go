package app_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/ses"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

const paymentSecret = "test-payment-secret"

func sign(body string) string {
	m := hmac.New(sha256.New, []byte(paymentSecret))
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))
}

const succeeded = `{"type":"payment.succeeded","payment_id":"Pay123","occurred_at":"2026-11-10T09:30:00Z","source":"payment-portal",` +
	`"customer":{"name":"Aisyah Rahman","phone":"+60123456789","email":"Aisyah@Example.com","language":""},` +
	`"product":"Workshop: Reading Annual Reports","amount":1234.50,"currency":"MYR","basis":"paid","reference":"stripe:pi_1",` +
	`"payment_method":"stripe-card","renewal":false,"subscription":null,"environment":"staging","paid_at":"2026-11-10T09:30:00Z",` +
	`"features":[],"receipt_url":"https://pay.test/pay-return?txn=Pay123"}`

func (e *env) paymentEvent(t *testing.T, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandlePaymentEvent(e.ctx, sign(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPaymentReceipt(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	// Someone who unsubscribed from marketing still gets their receipt, and no contact is made.
	if _, err := e.db.Pool.Exec(e.ctx, `INSERT INTO contacts (id, email, status) VALUES ('c1', 'other@example.com', 'unsubscribed')`); err != nil {
		t.Fatal(err)
	}

	out := e.paymentEvent(t, succeeded)
	if out["status"] != "sent" || out["created"] != true {
		t.Fatalf("first event: %v", out)
	}
	if e.ses.count() != 1 {
		t.Fatalf("sent %d, want 1", e.ses.count())
	}
	msg := decoded(e.ses.since(0)[0])
	for _, want := range []string{
		"To: \"Aisyah Rahman\" <aisyah@example.com>",
		"Subject: Payment received: Workshop: Reading Annual Reports (RM 1,234.50)",
		"Reply-To: hello@reply.grandpine.test",
		"Hi Aisyah,", "RM 1,234.50", "10 Nov 2026, 5:30 PM", "Card", "Pay123",
		`href="https://pay.test/pay-return?txn=Pay123"`,
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("receipt lacks %q", want)
		}
	}
	for _, unwanted := range []string{"List-Unsubscribe", "Unsubscribe", "/o?t=", "/r?t="} {
		if strings.Contains(msg, unwanted) {
			t.Errorf("receipt carries %q (transactional mail is not marketing)", unwanted)
		}
	}
	if n := e.scalar(t, `SELECT count(*) FROM contacts`); n != int64(1) {
		t.Errorf("contacts = %v, want the 1 already there", n)
	}

	// Payment retries the same event: nothing is sent twice.
	out = e.paymentEvent(t, succeeded)
	if out["created"] != false || e.ses.count() != 1 {
		t.Fatalf("retry: %v, sent %d", out, e.ses.count())
	}

	// A permanent bounce of the receipt shows on its row.
	e.ses.events = append(e.ses.events, ses.Event{Type: "Bounce", Permanent: true, MessageID: "ses-1", Recipients: []string{"aisyah@example.com"}})
	e.tick(t)
	rows, err := e.svc.Transactionals(e.ctx, "payment", "Pay123", "", "", 0)
	if err != nil || len(rows) != 1 || rows[0].Status != "bounced" {
		t.Fatalf("after bounce: %+v %v", rows, err)
	}

	// Staff resend.
	if st, err := e.svc.ResendTransactional(e.ctx, rows[0].ID); err != nil || st != "sent" || e.ses.count() != 2 {
		t.Fatalf("resend: %s %v, sent %d", st, err, e.ses.count())
	}
}

func TestPaymentEventGuards(t *testing.T) {
	e := setup(t, true)
	if _, err := e.svc.HandlePaymentEvent(e.ctx, sign(succeeded), []byte(succeeded)); !errors.Is(err, app.ErrHookOff) {
		t.Fatalf("without a secret: %v", err)
	}
	e.svc.PaymentEventSecret = paymentSecret
	if _, err := e.svc.HandlePaymentEvent(e.ctx, "00"+sign(succeeded)[2:], []byte(succeeded)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	failed := strings.Replace(succeeded, "payment.succeeded", "payment.failed", 1)
	if out := e.paymentEvent(t, failed); out["ignored"] == nil {
		t.Fatalf("payment.failed: %v", out)
	}
	noEmail := strings.Replace(succeeded, "Aisyah@Example.com", "", 1)
	if out := e.paymentEvent(t, noEmail); out["ignored"] == nil {
		t.Fatalf("no e-mail: %v", out)
	}
	if e.ses.count() != 0 {
		t.Fatalf("sent %d, want 0", e.ses.count())
	}
}

func TestBankTransferAndRefund(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	pending := `{"type":"payment.pending","payment_id":"Pay9","occurred_at":"2026-11-10T01:00:00Z","customer":{"name":"Lim","email":"lim@example.com"},` +
		`"product":"Annual plan","amount":99.00,"currency":"MYR","payment_method":"bank-transfer","reference":"bank_transfer:GP-7Q2",` +
		`"instructions_url":"https://pay.test/pay-return?txn=Pay9","expires_at":"2026-11-13T15:59:00Z","payment_reference":"GP-7Q2",` +
		`"bank_account":{"bank_name":"Maybank","account_number":"5140 1234 5678","account_name":"GrandPine Capital Sdn Bhd"}}`
	refunded := `{"type":"payment.refunded","payment_id":"Pay9","occurred_at":"2026-11-12T03:00:00Z","customer":{"name":"Lim","email":"lim@example.com"},` +
		`"product":"Annual plan","amount":99.00,"currency":"MYR","refund":{"actor":"staff","note":"","at":"2026-11-12T03:00:00Z"}}`
	e.paymentEvent(t, pending)
	e.paymentEvent(t, refunded)
	sent := e.ses.since(0)
	if len(sent) != 2 {
		t.Fatalf("sent %d, want 2", len(sent))
	}
	p, r := decoded(sent[0]), decoded(sent[1])
	for _, want := range []string{"How to pay for Annual plan (RM 99.00)", "Maybank", "5140 1234 5678", "GP-7Q2", "13 Nov 2026, 11:59 PM"} {
		if !strings.Contains(p, want) {
			t.Errorf("instructions lack %q", want)
		}
	}
	for _, want := range []string{"Your refund for Annual plan", "12 Nov 2026, 11:00 AM"} {
		if !strings.Contains(r, want) {
			t.Errorf("refund notice lacks %q", want)
		}
	}
}

func TestTransactionalWaitsForSES(t *testing.T) {
	e := setup(t, false) // no SES, not dry-run
	e.svc.PaymentEventSecret = paymentSecret
	out := e.paymentEvent(t, succeeded)
	if out["status"] != "queued" {
		t.Fatalf("without SES: %v", out)
	}
	if n := e.scalar(t, `SELECT attempts FROM transactional`); n != int32(0) {
		t.Fatalf("attempts = %v: waiting for SES must not use them up", n)
	}
}

func TestKeyedTemplateCannotBeDeleted(t *testing.T) {
	e := setup(t, false)
	err := e.svc.DeleteTemplate(e.ctx, "txn-payment-receipt")
	var ue app.UserError
	if !errors.As(err, &ue) {
		t.Fatalf("delete: %v", err)
	}
}

// A no-reply sender carries no Reply-To, and the e-mail says not to reply.
func TestNoReplySender(t *testing.T) {
	db, box, key := testdb.New(t)
	e := &env{db: db, ses: &fakeSES{}, now: time.Date(2026, 11, 10, 2, 0, 0, 0, time.UTC), ctx: context.Background()}
	cfg := mailCfg
	cfg.TransactionalFrom, cfg.TransactionalFromName = "no-reply@grandpine.test", "GrandPine Capital"
	e.svc = app.New(db, box, key, "https://mail.test", e.ses, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.svc.Now = func() time.Time { return e.now }
	e.svc.PaymentEventSecret = paymentSecret
	e.paymentEvent(t, succeeded)
	msg := decoded(e.ses.since(0)[0])
	if !strings.Contains(msg, `From: "GrandPine Capital" <no-reply@grandpine.test>`) || strings.Contains(msg, "Reply-To:") {
		t.Fatalf("no-reply receipt headers:\n%s", msg[:strings.Index(msg, "Content-Type")])
	}
	if !strings.Contains(msg, "please do not reply") {
		t.Error("receipt does not say not to reply")
	}
}

// The Transactional page: an e-mail turned off is not sent, another template and sender can be
// chosen, and the defaults come back when cleared.
func TestTransactionalConfig(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret
	var custom string
	if err := e.db.Pool.QueryRow(e.ctx, `INSERT INTO templates (id, name, mode, subject, html) VALUES ('t-custom', 'Our receipt', 'html',
		'Thanks {{first_name}}!', '<p>Custom receipt for {{item}}</p>') RETURNING id`).Scan(&custom); err != nil {
		t.Fatal(err)
	}
	err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{
		"from_email": "billing@grandpine.test", "from_name": "GP Billing",
		"events": map[string]any{
			"payment.succeeded": map[string]any{"enabled": true, "template_id": custom},
			"payment.refunded":  map[string]any{"enabled": false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := e.svc.TransactionalConfig(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	evs := cfg["events"].([]map[string]any)
	if evs[0]["template_id"] != custom || evs[0]["custom_template"] != true || evs[2]["enabled"] != false || evs[1]["template_id"] != "txn-payment-pending" {
		t.Fatalf("config = %+v", evs)
	}

	e.paymentEvent(t, succeeded)
	msg := decoded(e.ses.since(0)[0])
	for _, want := range []string{"Subject: Thanks Aisyah!", "Custom receipt for Workshop", `From: "GP Billing" <billing@grandpine.test>`} {
		if !strings.Contains(msg, want) {
			t.Errorf("receipt lacks %q", want)
		}
	}
	refunded := strings.Replace(succeeded, "payment.succeeded", "payment.refunded", 1)
	if out := e.paymentEvent(t, refunded); out["ignored"] == nil || e.ses.count() != 1 {
		t.Fatalf("refund while off: %v, sent %d", out, e.ses.count())
	}

	var ue app.UserError
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"from_email": "x@unverified.test"}); !errors.As(err, &ue) {
		t.Fatalf("unverified sender: %v", err)
	}
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"payment.succeeded": map[string]any{"template_id": "gone"}}}); !errors.As(err, &ue) {
		t.Fatalf("missing template: %v", err)
	}
	// Cleared: defaults again.
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if from, _ := e.svc.TransactionalFrom(e.ctx); from != "hello@grandpine.test" {
		t.Fatalf("default sender = %s", from)
	}
}

const chargeUpcoming = `{"type":"subscription.charge_upcoming","payment_id":"Pay77","occurred_at":"2026-11-22T08:00:00Z","source":"payment-portal",` +
	`"customer":{"name":"Aisyah Rahman","phone":"+60123456789","email":"aisyah@example.com","language":""},` +
	`"product":"ValueFarm Pro","amount":0.00,"currency":"MYR","basis":"paid","reference":"stripe:cs_1","payment_method":"stripe",` +
	`"renewal":false,"subscription":{"id":"Sub1","cycle":1},"environment":"staging","paid_at":"","features":[],` +
	`"charge_at":"2026-11-25T16:30:00Z","charge_amount":1428.00,"plan_start":"trial"}`

func TestChargeUpcomingNotice(t *testing.T) {
	e := setup(t, true)
	e.svc.PaymentEventSecret = paymentSecret

	out := e.paymentEvent(t, chargeUpcoming)
	if out["status"] != "sent" || out["created"] != true {
		t.Fatalf("notice: %v", out)
	}
	rows, err := e.svc.Transactionals(e.ctx, "payment", "Pay77", "", "", 0)
	if err != nil || len(rows) != 1 || rows[0].TemplateKey != "subscription_charge_upcoming" {
		t.Fatalf("row: %+v %v", rows, err)
	}
	msg := decoded(e.ses.since(0)[0])
	for _, want := range []string{
		"To: \"Aisyah Rahman\" <aisyah@example.com>",
		"Subject: Your ValueFarm Pro plan: first charge in 3 days",
		"Hi Aisyah,", "ValueFarm Pro", "26 Nov 2026", "RM 1,428.00", "every year", "Manage plan", "Pay77",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("notice lacks %q", want)
		}
	}
	// RM 0.00, the free order's own amount, must not be what the member is told.
	if strings.Contains(msg, "RM 0.00") {
		t.Error("notice shows the RM 0.00 opening order instead of the charge")
	}

	// Payment retries the same event: nothing is sent twice.
	if out = e.paymentEvent(t, chargeUpcoming); out["created"] != false || e.ses.count() != 1 {
		t.Fatalf("retry: %v, sent %d", out, e.ses.count())
	}

	// Turned off on the Transactional page: acknowledged, nothing sent.
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"subscription.charge_upcoming": map[string]any{"enabled": false}}}); err != nil {
		t.Fatal(err)
	}
	other := strings.Replace(chargeUpcoming, "Pay77", "Pay78", 1)
	if out = e.paymentEvent(t, other); out["ignored"] == nil || e.ses.count() != 1 {
		t.Fatalf("turned off: %v, sent %d", out, e.ses.count())
	}
}
