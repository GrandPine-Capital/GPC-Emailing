package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

// GPC-WhatsApp's outbound webhooks (docs/API.md there), one signed route:
//
//	POST /hooks/whatsapp  headers X-GPC-Event and X-GPC-Signature: sha256=<hex HMAC-SHA256 of the raw body>
//
// with the admin setting gpc_whatsapp_webhook_secret (Settings → Integrations). The platform does
// not retry and disables a webhook after 20 failures in a row, so anything validly signed gets a
// 2xx, including events this service does not use.
//
//	message.received  a customer's reply: recorded like ChatDaddy's message-insert (replies row,
//	                  whatsapp_received, stop_if: replied)
//	message.status    sent / delivered / read / failed for a message we sent; failed is shown on
//	                  the Transactional page (never resent by itself)

// ErrWhatsAppHookOff: gpc_whatsapp_webhook_secret is not set.
var ErrWhatsAppHookOff = errors.New("the GPC WhatsApp webhook is not set up (Settings → Integrations → Webhook secret)")

// HandleWhatsAppHook verifies and handles one delivery from GPC-WhatsApp.
func (s *Service) HandleWhatsAppHook(ctx context.Context, eventHeader, sig string, body []byte) (map[string]any, error) {
	secret := s.Secrets(ctx)["gpc_whatsapp_webhook_secret"]
	if secret == "" {
		return nil, ErrWhatsAppHookOff
	}
	hexSig, ok := strings.CutPrefix(strings.TrimSpace(sig), "sha256=")
	if !ok || !VerifySignature(secret, body, hexSig) {
		return nil, ErrBadSignature
	}
	var env struct {
		Event string `json:"event"`
		Data  struct {
			Message struct {
				ID        string `json:"id"`
				Direction string `json:"direction"`
				Type      string `json:"type"`
				Text      string `json:"text"`
				Phone     string `json:"phone"`
			} `json:"message"`
			Contact struct {
				Phone string `json:"phone"`
				Name  string `json:"name"`
			} `json:"contact"`
			MessageID         string `json:"messageId"`
			ProviderMessageID string `json:"providerMessageId"`
			Status            string `json:"status"`
			Error             string `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, userErr("not JSON")
	}
	event := env.Event
	if event == "" {
		event = eventHeader
	}
	d := env.Data
	switch event {
	case "message.received":
		m := d.Message
		if m.ID == "" || strings.EqualFold(m.Direction, "out") {
			return map[string]any{"ok": true, "ignored": "no incoming message"}, nil
		}
		phone := m.Phone
		if phone == "" {
			phone = d.Contact.Phone
		}
		text := m.Text
		if text == "" && m.Type != "" && m.Type != "text" {
			text = "[" + m.Type + "]"
		}
		handled, err := s.incomingWhatsApp(ctx, phone, d.Contact.Name, text, m.ID)
		if err != nil {
			return nil, err
		}
		if !handled {
			return map[string]any{"ok": true, "ignored": "no usable phone number"}, nil
		}
		return map[string]any{"ok": true}, nil
	case "message.status":
		return s.whatsAppStatus(ctx, d.MessageID, d.ProviderMessageID, d.Status, d.Error)
	}
	return map[string]any{"ok": true, "ignored": "event " + event}, nil
}

// whatsAppStatus applies a delivery status to the send it is about: a payment or Keycloak
// notice (transactional.provider_id) or an automation send (whatsapp.id = wa-<id>).
func (s *Service) whatsAppStatus(ctx context.Context, messageID, providerID, status, errText string) (map[string]any, error) {
	ids := []string{}
	for _, id := range []string{messageID, providerID} {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return map[string]any{"ok": true, "ignored": "unknown message"}, nil
	}
	var txnID string
	err := s.db.Pool.QueryRow(ctx, `SELECT id FROM transactional WHERE channel = 'whatsapp' AND provider_id = ANY($1) LIMIT 1`, ids).Scan(&txnID)
	switch {
	case err == nil:
		// delivered and read have no place on a transactional row (SES delivery is not stored
		// either, only a bounce or complaint), so they are acknowledged and left.
		if status == "failed" {
			msg := core.Truncate(strings.TrimSpace(errText), 500)
			if msg == "" {
				msg = "no reason given"
			}
			if _, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'failed', error = $2 WHERE id = $1`, txnID, "WhatsApp: "+msg); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true, "status": status}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, err
	}
	var waIDs []string
	for _, id := range ids {
		waIDs = append(waIDs, "wa-"+id) // logWhatsApp keeps the platform's id as it is
	}
	var n int
	if err := s.db.Pool.QueryRow(ctx, `SELECT count(*) FROM whatsapp WHERE id = ANY($1) AND direction = 'out'`, waIDs).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return map[string]any{"ok": true, "ignored": "unknown message"}, nil
	}
	// The whatsapp table (the contact's timeline) has no status or error column: an automation
	// send's failure is only logged.
	if status == "failed" {
		s.log.Warn("automation WhatsApp failed after it was accepted", "message", ids[0], "error", errText)
	}
	return map[string]any{"ok": true, "status": status}, nil
}
