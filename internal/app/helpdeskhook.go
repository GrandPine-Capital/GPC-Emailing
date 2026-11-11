package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

// GPC-CSTicket's (Helpdesk) requests: POST /hooks/helpdesk with the event JSON as the body and
// header sig = lowercase hex HMAC-SHA256 of the body with HELPDESK_EVENT_SECRET, the same
// contract as /hooks/payments. Helpdesk sends its customer password-reset mail this way, so no
// SMTP credentials are needed (SES offers no SMTP endpoint in ap-southeast-5).

// ErrHelpdeskHookOff: HELPDESK_EVENT_SECRET is not set, so the hook accepts nothing.
var ErrHelpdeskHookOff = errors.New("helpdesk events are not set up (HELPDESK_EVENT_SECRET)")

type helpdeskEvent struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	OccurredAt string `json:"occurred_at"`
	Customer   struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"customer"`
	ResetURL  string `json:"reset_url"`
	ExpiresAt string `json:"expires_at"`
}

// HandleHelpdeskEvent queues (and tries at once to send) the e-mail a Helpdesk event calls for.
// Events with no template or no customer e-mail are acknowledged and ignored.
func (s *Service) HandleHelpdeskEvent(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if s.HelpdeskEventSecret == "" {
		return nil, ErrHelpdeskHookOff
	}
	if !VerifySignature(s.HelpdeskEventSecret, body, sig) {
		return nil, ErrBadSignature
	}
	var ev helpdeskEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.Type == "" || strings.TrimSpace(ev.ID) == "" {
		return nil, userErr("not a helpdesk event")
	}
	te, ok := txnEvent(ev.Type)
	if !ok || te.Source != "helpdesk" {
		return map[string]any{"ok": true, "ignored": "no e-mail for " + ev.Type}, nil
	}
	set := s.txnSettings(ctx).Events[ev.Type]
	if set.Off {
		return map[string]any{"ok": true, "ignored": te.Label + " is turned off (Transactional page)"}, nil
	}
	if !core.IsEmail(ev.Customer.Email) {
		return map[string]any{"ok": true, "ignored": "no customer e-mail"}, nil
	}
	if !strings.HasPrefix(ev.ResetURL, "https://") && !strings.HasPrefix(ev.ResetURL, "http://") {
		return nil, userErr("reset_url must be an http(s) URL")
	}
	vars := map[string]string{
		"name": strings.TrimSpace(ev.Customer.Name), "reset_url": ev.ResetURL, "expires_at": localTime(ev.ExpiresAt),
	}
	id, created, err := s.QueueTransactional(ctx, TxnRequest{
		Source: "helpdesk", Key: ev.Type + ":" + ev.ID, Template: te.DefaultKey, TemplateID: set.TemplateID,
		To: ev.Customer.Email, ToName: ev.Customer.Name, Reference: ev.ID, Vars: vars,
	})
	if err != nil {
		return nil, err
	}
	status, err := s.SendTransactional(ctx, id)
	if err != nil {
		s.log.Warn("helpdesk e-mail not sent yet", "id", id, "type", ev.Type, "err", err)
	}
	return map[string]any{"ok": true, "id": id, "created": created, "status": status}, nil
}
