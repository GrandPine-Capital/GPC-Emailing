package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

// Keycloak's account e-mails (set a new password, forgot password, verify the address): the
// e-mail hook provider in the Keycloak image (ValueFarm.KeycloakTheme, providers/gpc-email-hook)
// posts each one here instead of sending it itself. POST /hooks/keycloak with the event JSON as
// the body and header sig = lowercase hex HMAC-SHA256 of the body with KEYCLOAK_EVENT_SECRET,
// the same contract as /hooks/payments.
//
// The answer always says whether the e-mail is now this service's: "handled": true only once it
// has been sent. On anything else (the event turned off on the Transactional page, dry-run mode,
// SES refusing, no template, an error status) Keycloak sends its own e-mail, so a person asking
// for a new password always gets one.

// ErrKeycloakHookOff: KEYCLOAK_EVENT_SECRET is not set, so the hook accepts nothing.
var ErrKeycloakHookOff = errors.New("keycloak events are not set up (KEYCLOAK_EVENT_SECRET)")

type keycloakEvent struct {
	Type       string `json:"type"`
	ID         string `json:"id"` // one per e-mail Keycloak sends: the idempotency key
	OccurredAt string `json:"occurred_at"`
	Realm      string `json:"realm"`
	RealmName  string `json:"realm_name"`
	User       struct {
		ID        string `json:"id"`
		Username  string `json:"username"`
		Email     string `json:"email"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Phone     string `json:"phone"`
	} `json:"user"`
	Link            string `json:"link"`
	ExpiresIn       string `json:"expires_in"` // "12 hours", as Keycloak words it
	ExpiresAt       string `json:"expires_at"`
	RequiredActions string `json:"required_actions"`
}

// HandleKeycloakEvent sends the e-mail a Keycloak event calls for, and queues its WhatsApp
// notice when that is switched on.
func (s *Service) HandleKeycloakEvent(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if s.KeycloakEventSecret == "" {
		return nil, ErrKeycloakHookOff
	}
	if !VerifySignature(s.KeycloakEventSecret, body, sig) {
		return nil, ErrBadSignature
	}
	var ev keycloakEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.Type == "" || strings.TrimSpace(ev.ID) == "" {
		return nil, userErr("not a keycloak event")
	}
	left := func(why string) map[string]any { return map[string]any{"ok": true, "handled": false, "ignored": why} }
	te, ok := txnEvent(ev.Type)
	if !ok || te.Source != "keycloak" {
		return left("no e-mail for " + ev.Type), nil
	}
	if !core.IsEmail(ev.User.Email) {
		return left("no user e-mail"), nil
	}
	if !strings.HasPrefix(ev.Link, "https://") && !strings.HasPrefix(ev.Link, "http://") {
		return nil, userErr("link must be an http(s) URL")
	}
	name := strings.TrimSpace(ev.User.FirstName + " " + ev.User.LastName)
	// What a WhatsApp notice may say: everything but the link, which stays in the e-mail (a
	// phone number on a Keycloak account is not verified).
	notice := map[string]string{
		"first_name": strings.TrimSpace(ev.User.FirstName), "full_name": name, "username": ev.User.Username,
		"realm_name": ev.RealmName, "expires_in": ev.ExpiresIn, "expires_at": localTime(ev.ExpiresAt),
		"required_actions": ev.RequiredActions,
	}
	vars := map[string]string{"action_url": ev.Link}
	for k, v := range notice {
		vars[k] = v
	}
	reference := ev.User.ID
	if reference == "" {
		reference = ev.ID
	}
	set := s.txnSettings(ctx).Events[ev.Type]
	var out map[string]any
	if set.Off {
		out = left(te.Label + " is turned off (Transactional page)")
	} else {
		id, created, err := s.QueueTransactional(ctx, TxnRequest{
			Source: "keycloak", Key: ev.Type + ":" + ev.ID, Template: te.DefaultKey, TemplateID: set.TemplateID,
			To: ev.User.Email, ToName: name, Reference: reference, Vars: vars,
		})
		if err != nil {
			return nil, err
		}
		status, sendErr := s.SendTransactional(ctx, id)
		var dry bool
		if err := s.db.Pool.QueryRow(ctx, `SELECT status, dry_run FROM transactional WHERE id = $1`, id).Scan(&status, &dry); err != nil {
			return nil, err
		}
		out = map[string]any{"ok": true, "id": id, "created": created, "status": status, "handled": status == "sent" && !dry}
		switch {
		case status == "sent" && dry:
			out["ignored"] = "dry-run mode: recorded, not delivered"
		case status != "sent":
			// Keycloak sends its own now. Ours must not follow it later from the worker's retries.
			why := "left to Keycloak"
			if sendErr != nil {
				why += ": " + sendErr.Error()
			}
			if _, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'skipped', error = $2 WHERE id = $1 AND status IN ('queued', 'failed')`,
				id, core.Truncate(why, 500)); err != nil {
				return nil, err
			}
			out["status"], out["ignored"] = "skipped", why
			s.log.Warn("keycloak e-mail left to Keycloak", "id", id, "type", ev.Type, "err", sendErr)
		}
	}
	if _, ok := whatsAppDefaultText[ev.Type]; ok && set.WhatsApp.On {
		// Queued for the worker, which is woken now: Keycloak is waiting for this answer, and a
		// slow WhatsApp call must not make it give up and send a second e-mail.
		wa, err := s.queueTxnWhatsApp(ctx, TxnRequest{
			Source: "keycloak", Key: ev.Type + ":" + ev.ID + ":whatsapp", Template: te.DefaultKey,
			To: ev.User.Email, ToName: name, Reference: reference, Vars: notice,
		}, ev.User.Phone, false)
		if err != nil {
			return nil, err
		}
		out["whatsapp"] = wa
		s.Wake()
	}
	return out, nil
}
