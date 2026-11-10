package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

// GPC-Payment's events (its outbox target "emailing"): POST /hooks/payments with the event
// JSON as the body and header sig = lowercase hex HMAC-SHA256 of the body with
// PAYMENT_EVENT_SECRET, the same contract the CRM and ValueFarm.Capability receive. Each event
// type that has a customer e-mail maps to a transactional template.

// ErrHookOff: PAYMENT_EVENT_SECRET is not set, so the hook accepts nothing.
var ErrHookOff = errors.New("payment events are not set up (PAYMENT_EVENT_SECRET)")

// ErrBadSignature: the sig header does not match the body.
var ErrBadSignature = errors.New("invalid signature")

// paymentTemplates maps an event type to the template it sends.
var paymentTemplates = map[string]string{
	"payment.succeeded": "payment_receipt",
	"payment.pending":   "payment_pending",
	"payment.refunded":  "payment_refunded",
}

type paymentEvent struct {
	Type       string `json:"type"`
	PaymentID  string `json:"payment_id"`
	OccurredAt string `json:"occurred_at"`
	Customer   struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"customer"`
	Product          string      `json:"product"`
	Amount           json.Number `json:"amount"`
	Currency         string      `json:"currency"`
	Basis            string      `json:"basis"`
	Reference        string      `json:"reference"`
	PaymentMethod    string      `json:"payment_method"`
	Renewal          bool        `json:"renewal"`
	PaidAt           string      `json:"paid_at"`
	ReceiptURL       string      `json:"receipt_url"`
	InstructionsURL  string      `json:"instructions_url"`
	ExpiresAt        string      `json:"expires_at"`
	PaymentReference string      `json:"payment_reference"`
	BankAccount      *struct {
		BankName      string `json:"bank_name"`
		AccountNumber string `json:"account_number"`
		AccountName   string `json:"account_name"`
		DuitNowID     string `json:"duitnow_id"`
	} `json:"bank_account"`
	Refund *struct {
		At string `json:"at"`
	} `json:"refund"`
}

// myt is the time zone dates in e-mails are written in.
var myt = time.FixedZone("MYT", 8*3600)

// localTime writes an RFC 3339 time as "10 Nov 2026, 5:30 PM" in Malaysia time.
func localTime(rfc string) string {
	t, err := time.Parse(time.RFC3339, rfc)
	if err != nil {
		return ""
	}
	return t.In(myt).Format("2 Jan 2006, 3:04 PM")
}

// formatAmount writes 1234.5 MYR as "RM 1,234.50".
func formatAmount(n json.Number, currency string) string {
	f, err := n.Float64()
	if err != nil {
		return string(n)
	}
	cents := int64(f*100 + 0.5)
	if f < 0 {
		cents = int64(f*100 - 0.5)
	}
	sign := ""
	if cents < 0 {
		sign, cents = "-", -cents
	}
	whole := strconv.FormatInt(cents/100, 10)
	for i := len(whole) - 3; i > 0; i -= 3 {
		whole = whole[:i] + "," + whole[i:]
	}
	prefix := strings.ToUpper(currency) + " "
	if currency == "" || strings.EqualFold(currency, "MYR") {
		prefix = "RM "
	}
	return prefix + sign + whole + "." + strconv.FormatInt(100+cents%100, 10)[1:]
}

// methodLabel is the payment method as a buyer would name it.
func methodLabel(method, reference string) string {
	m := strings.ToLower(method + " " + reference)
	switch {
	case strings.Contains(m, "bank"):
		return "Bank transfer"
	case strings.Contains(m, "stripe"), strings.Contains(m, "card"):
		return "Card"
	case strings.Contains(m, "fpx"), strings.Contains(m, "toyyibpay"):
		return "Online banking (FPX)"
	case strings.Contains(m, "ipay88"), strings.Contains(m, "senangpay"):
		return "Online payment"
	case strings.Contains(m, "manual"), strings.Contains(m, "none"), strings.TrimSpace(m) == "":
		return "Recorded by our team"
	}
	return method
}

// VerifySignature checks sig (hex HMAC-SHA256 of body) against secret.
func VerifySignature(secret string, body []byte, sig string) bool {
	want, err := hex.DecodeString(strings.TrimSpace(sig))
	if err != nil || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(want, mac.Sum(nil))
}

// HandlePaymentEvent queues (and tries at once to send) the e-mail a payment event calls for.
// Events with no template or no customer e-mail are acknowledged and ignored, so Payment does
// not retry them.
func (s *Service) HandlePaymentEvent(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if s.PaymentEventSecret == "" {
		return nil, ErrHookOff
	}
	if !VerifySignature(s.PaymentEventSecret, body, sig) {
		return nil, ErrBadSignature
	}
	var ev paymentEvent
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	if err := dec.Decode(&ev); err != nil || ev.Type == "" || ev.PaymentID == "" {
		return nil, userErr("not a payment event")
	}
	tmpl, ok := paymentTemplates[ev.Type]
	if !ok {
		return map[string]any{"ok": true, "ignored": "no e-mail for " + ev.Type}, nil
	}
	if !core.IsEmail(ev.Customer.Email) {
		return map[string]any{"ok": true, "ignored": "no customer e-mail"}, nil
	}
	vars := map[string]string{
		"order_id": ev.PaymentID, "item": ev.Product, "amount": formatAmount(ev.Amount, ev.Currency), "currency": ev.Currency,
		"payment_method": methodLabel(ev.PaymentMethod, ev.Reference), "paid_at": localTime(ev.PaidAt),
		"receipt_url": ev.ReceiptURL, "instructions_url": ev.InstructionsURL, "expires_at": localTime(ev.ExpiresAt),
		"payment_reference": ev.PaymentReference, "renewal": "",
	}
	if ev.Renewal {
		vars["renewal"] = "yes"
	}
	if vars["paid_at"] == "" {
		vars["paid_at"] = localTime(ev.OccurredAt)
	}
	if ev.Item() == "" {
		vars["item"] = "your order"
	}
	if a := ev.BankAccount; a != nil {
		vars["bank_name"], vars["account_number"], vars["account_name"], vars["duitnow_id"] = a.BankName, a.AccountNumber, a.AccountName, a.DuitNowID
	}
	if ev.Refund != nil {
		vars["refunded_at"] = localTime(ev.Refund.At)
	}
	id, created, err := s.QueueTransactional(ctx, TxnRequest{
		Source: "payment", Key: ev.Type + ":" + ev.PaymentID, Template: tmpl,
		To: ev.Customer.Email, ToName: ev.Customer.Name, Reference: ev.PaymentID, Vars: vars,
	})
	if err != nil {
		return nil, err
	}
	status, err := s.SendTransactional(ctx, id)
	if err != nil {
		// Recorded and queued: the worker retries. Payment need not.
		s.log.Warn("payment e-mail not sent yet", "id", id, "type", ev.Type, "err", err)
	}
	return map[string]any{"ok": true, "id": id, "created": created, "status": status}, nil
}

// Item is the product name.
func (e paymentEvent) Item() string { return strings.TrimSpace(e.Product) }
