package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

// Payment WhatsApp: the payment events that send an e-mail (receipt, bank-transfer
// instructions, refund, plan first charge) can also send the buyer a WhatsApp message. It goes
// through GPC-WhatsApp's API (POST /api/v1/messages with the company's API key), so it is in
// that platform's inbox and its rules apply (opt-out, a personal number's daily limit). Each
// event chooses its number: the company's personal number with free text, or a WABA number with
// an approved template whose body parameters are merge tags. It is off for every event until
// staff switch it on (the Transactional page): the CRM may still be sending its own.

// whatsAppDefaultText is the wording used while an event's text is empty. A line whose merge
// tags are all empty is left out, so an order without a DuitNow ID shows no "DuitNow ID:" line.
var whatsAppDefaultText = map[string]string{
	"payment.succeeded": "Hi {{first_name}}, thank you! We have received your payment of {{amount}} for {{item}}.\n\n" +
		"Order: {{order_id}}\nPaid: {{paid_at}} ({{payment_method}})\n\nYour receipt: {{receipt_url}}",
	"payment.pending": "Hi {{first_name}}, thank you for your order of {{item}}. To complete it, please transfer {{amount}} to:\n\n" +
		"Bank: {{bank_name}}\nAccount name: {{account_name}}\nAccount number: {{account_number}}\nDuitNow ID: {{duitnow_id}}\n" +
		"Reference: {{payment_reference}}\n\nPlease pay by {{expires_at}}.\nPayment details: {{instructions_url}}\n\nReply here if you need any help.",
	"payment.refunded": "Hi {{first_name}}, we have refunded {{amount}} for {{item}} (order {{order_id}}) on {{refunded_at}}. " +
		"It may take a few working days to reach your account.\n\nDetails: {{receipt_url}}",
	"subscription.charge_upcoming": "Hi {{first_name}}, a reminder: the free days of your {{item}} plan end soon. " +
		"Your card will be charged {{charge_amount}} on {{charge_at}}, and then every year.\n\nReply here if you have any questions.",
	// Keycloak's account e-mails: a notice only. The link itself is never among a WhatsApp
	// message's merge values (HandleKeycloakEvent), so it stays in the e-mail.
	"keycloak.execute_actions": "Hi {{first_name|there}}, we have just e-mailed you a link to set a new {{realm_name|ValueFarm}} password. " +
		"It works for {{expires_in}}.\n\nIf you did not ask for this, you can ignore it: your password stays the same.",
	"keycloak.password_reset": "Hi {{first_name|there}}, we have just e-mailed you a link to reset your {{realm_name|ValueFarm}} password. " +
		"It works for {{expires_in}}.\n\nIf you did not ask for this, you can ignore it: your password stays the same.",
	"keycloak.verify_email": "Hi {{first_name|there}}, we have just e-mailed you a link to confirm the e-mail address of your {{realm_name|ValueFarm}} account. " +
		"It works for {{expires_in}}.",
}

const (
	maxWhatsAppText   = 4000
	maxWhatsAppParams = 20
)

// txnWhatsApp is one event's WhatsApp setting.
type txnWhatsApp struct {
	On       bool     `json:"enabled"`
	Channel  string   `json:"channel"`  // "personal" (the company's free number) or a GPC-WhatsApp channel id
	Kind     string   `json:"kind"`     // "text" or "template" (WABA numbers)
	Text     string   `json:"text"`     // empty = whatsAppDefaultText
	Template string   `json:"template"` // the approved template's name
	Language string   `json:"language"`
	Params   []string `json:"params"` // the template's body parameters, in order, as merge text
}

func whatsAppSetting(v any) txnWhatsApp {
	var w txnWhatsApp
	if b, err := json.Marshal(v); err == nil {
		_ = json.Unmarshal(b, &w)
	}
	return w
}

func (w txnWhatsApp) withDefaults() txnWhatsApp {
	if w.Channel == "" {
		w.Channel = "personal"
	}
	if w.Kind != "template" {
		w.Kind = "text"
	}
	if w.Language == "" {
		w.Language = "en"
	}
	if w.Params == nil {
		w.Params = []string{}
	}
	return w
}

// cleanWhatsApp checks one event's WhatsApp setting from the Transactional page.
func cleanWhatsApp(e TxnEvent, v any) (map[string]any, error) {
	m, _ := v.(map[string]any)
	w := txnWhatsApp{
		On: m["enabled"] == true, Channel: strings.TrimSpace(str(m["channel"])), Kind: str(m["kind"]),
		Text: strings.TrimSpace(str(m["text"])), Template: strings.TrimSpace(str(m["template"])), Language: strings.TrimSpace(str(m["language"])),
	}
	if ps, ok := m["params"].([]any); ok {
		for _, p := range ps {
			w.Params = append(w.Params, strings.TrimSpace(str(p)))
		}
	}
	w = w.withDefaults()
	switch {
	case len(w.Channel) > 64:
		return nil, userErr("Choose the WhatsApp number for " + e.Label + " again")
	case len(w.Text) > maxWhatsAppText:
		return nil, userErr(fmt.Sprintf("The WhatsApp message for %s is longer than %d characters", e.Label, maxWhatsAppText))
	case len(w.Params) > maxWhatsAppParams:
		return nil, userErr(fmt.Sprintf("A WhatsApp template takes at most %d parameters", maxWhatsAppParams))
	case w.Kind == "template" && w.Channel == "personal":
		return nil, userErr("Templates go from a WABA number: choose one for " + e.Label + ", or send a text")
	case w.Kind == "template" && w.Template == "" && w.On:
		return nil, userErr("Enter the approved WhatsApp template's name for " + e.Label)
	}
	return map[string]any{"enabled": w.On, "channel": w.Channel, "kind": w.Kind, "text": w.Text,
		"template": w.Template, "language": w.Language, "params": w.Params}, nil
}

// waConnection is the GPC-WhatsApp platform's address and API key, when both are set.
func (s *Service) waConnection(ctx context.Context) (base, key string, ok bool) {
	base, key = strings.TrimRight(s.Settings(ctx).GPCWhatsAppURL, "/"), s.Secrets(ctx)["gpc_whatsapp_key"]
	return base, key, base != "" && key != ""
}

// errWhatsAppOff: the platform is not connected yet; the message waits for it.
var errWhatsAppOff = errors.New("GPC WhatsApp is not connected (Settings → Integrations: its address and API key)")

// waCall makes one request to GPC-WhatsApp's API and decodes the JSON answer.
func (s *Service) waCall(ctx context.Context, method, path string, body any) (int, map[string]any, error) {
	base, key, ok := s.waConnection(ctx)
	if !ok {
		return 0, nil, errWhatsAppOff
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, base+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.HTTP.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("GPC WhatsApp: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if e, ok := out["error"].(map[string]any); ok && str(e["message"]) != "" {
			msg = str(e["message"])
		} else if str(out["error"]) != "" {
			msg = str(out["error"])
		}
		return res.StatusCode, out, fmt.Errorf("GPC WhatsApp error %d: %s", res.StatusCode, core.Truncate(msg, 300))
	}
	return res.StatusCode, out, nil
}

// WhatsAppChannels lists the company's numbers on GPC-WhatsApp, for the Transactional page.
func (s *Service) WhatsAppChannels(ctx context.Context) ([]map[string]any, error) {
	_, out, err := s.waCall(ctx, http.MethodGet, "/api/v1/channels", nil)
	if errors.Is(err, errWhatsAppOff) {
		return nil, userErr(err.Error())
	} else if err != nil {
		return nil, err
	}
	list := []map[string]any{}
	if data, ok := out["data"].([]any); ok {
		for _, d := range data {
			if m, ok := d.(map[string]any); ok {
				list = append(list, map[string]any{"id": m["id"], "type": m["type"], "name": m["name"], "phone_number": m["phone_number"], "status": m["status"]})
			}
		}
	}
	return list, nil
}

var waTagRe = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}`)

// whatsAppText merges a WhatsApp message, leaving out each line whose merge tags all came out
// empty.
func whatsAppText(text string, vars map[string]string) string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if tags := waTagRe.FindAllStringSubmatch(line, -1); len(tags) > 0 {
			empty := true
			for _, t := range tags {
				if vars[t[1]] != "" || t[2] != "" {
					empty = false
				}
			}
			if empty {
				continue
			}
		}
		out = append(out, core.Merge(line, vars, false))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// queuePaymentWhatsApp records and tries at once the WhatsApp message a payment event calls for.
func (s *Service) queuePaymentWhatsApp(ctx context.Context, ev paymentEvent, te TxnEvent, vars map[string]string) (map[string]any, error) {
	return s.queueTxnWhatsApp(ctx, TxnRequest{
		Source: "payment", Key: ev.Type + ":" + ev.PaymentID + ":whatsapp", Template: te.DefaultKey,
		To: ev.Customer.Email, ToName: ev.Customer.Name, Reference: ev.PaymentID, Vars: vars,
	}, ev.Customer.Phone, true)
}

// queueTxnWhatsApp records the WhatsApp message of an event for the person at phone (as the
// asking system has it; a local number takes the default country code). With now it is also
// tried at once; otherwise the worker sends it.
func (s *Service) queueTxnWhatsApp(ctx context.Context, r TxnRequest, phone string, now bool) (map[string]any, error) {
	cc := s.Settings(ctx).DefaultCountryCode
	if cc == "" {
		cc = "60" // GrandPine's customers are in Malaysia: 012-… is +60 12-…
	}
	r.Channel, r.ToPhone = "whatsapp", core.PhoneKey(phone, cc)
	if r.ToPhone == "" {
		return map[string]any{"ignored": "no phone number"}, nil
	}
	id, created, err := s.QueueTransactional(ctx, r)
	if err != nil {
		return nil, err
	}
	status := "queued"
	if now {
		if status, err = s.SendTransactional(ctx, id); err != nil {
			s.log.Warn("whatsapp not sent yet", "id", id, "source", r.Source, "err", err)
		}
	}
	return map[string]any{"id": id, "created": created, "status": status}, nil
}

// sendTxnWhatsApp sends a claimed WhatsApp row with its event's current setting.
func (s *Service) sendTxnWhatsApp(ctx context.Context, r *TxnRow, fail func(error, bool) (string, error)) (string, error) {
	if _, _, ok := s.waConnection(ctx); !ok {
		// Not a failure of this message: wait for the connection, without using up attempts.
		_, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET attempts = attempts - 1, next_attempt_at = $2, error = $3 WHERE id = $1`,
			r.ID, s.now().Add(time.Hour), errWhatsAppOff.Error())
		return "queued", errors.Join(errWhatsAppOff, err)
	}
	event, _, _ := strings.Cut(r.SourceKey, ":")
	w := s.txnSettings(ctx).Events[event].WhatsApp.withDefaults()
	vars := s.txnVars(ctx, r)
	body := map[string]any{"channelId": w.Channel, "to": r.ToPhone, "ref": r.Reference,
		// Retries of this send share the key, so GPC-WhatsApp sends it once; a resend is a new message.
		"idempotencyKey": "emailing:" + r.ID + "#" + strconv.Itoa(r.Resends)}
	var preview string
	if w.Kind == "template" {
		if w.Template == "" {
			return fail(errors.New("no WhatsApp template is chosen for this message (Settings → Transactional e-mails)"), true)
		}
		t := map[string]any{"name": w.Template, "language": w.Language}
		if len(w.Params) > 0 {
			params := make([]any, len(w.Params))
			for i, p := range w.Params {
				v := strings.TrimSpace(core.Merge(p, vars, false))
				if v == "" {
					v = "-" // WhatsApp refuses an empty parameter
				}
				params[i] = map[string]any{"type": "text", "text": v}
			}
			t["components"] = []any{map[string]any{"type": "body", "parameters": params}}
		}
		body["template"], preview = t, "Template "+w.Template
	} else {
		text := w.Text
		if text == "" {
			text = whatsAppDefaultText[event]
		}
		body["text"] = whatsAppText(text, vars)
		preview = core.Truncate(strings.ReplaceAll(str(body["text"]), "\n", " "), 120)
		if preview == "" {
			return fail(errors.New("the WhatsApp message is empty (Settings → Transactional e-mails)"), true)
		}
	}
	if s.Settings(ctx).DryRun {
		_, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'sent', subject = $2, sent_at = $3, error = NULL, dry_run = true WHERE id = $1`,
			r.ID, preview, s.now())
		return "sent", err
	}
	code, out, err := s.waCall(ctx, http.MethodPost, "/api/v1/messages", body)
	switch {
	case err != nil && (code == http.StatusBadRequest || code == http.StatusUnauthorized || code == http.StatusForbidden || code == http.StatusNotFound):
		return fail(err, true) // the request is wrong (key, number, template): a retry would not change it
	case err != nil:
		return fail(err, false) // down, busy, or the number offline or at its daily limit
	case str(out["status"]) == "failed":
		return fail(fmt.Errorf("WhatsApp: %s", str(out["error"])), false)
	}
	_, err = s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'sent', provider_id = $2, subject = $3, sent_at = $4, error = NULL, dry_run = false WHERE id = $1`,
		r.ID, nilIfEmpty(str(out["messageId"])), preview, s.now())
	return "sent", err
}
