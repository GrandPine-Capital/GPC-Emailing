package app

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Automatic set-up of GPC-WhatsApp's webhook: this service holds the platform's address and an API
// key, so it creates its own outbound webhook subscription (POST /api/v1/webhooks, needs the scope
// webhooks:write) and keeps the signing secret from the response as gpc_whatsapp_webhook_secret.
// Its progress is the settings document "wa_webhook": state, reason, webhook_id, at (when it was
// connected) and attempted_at (the last try, for the retry interval). The secret is never in it.

const (
	waHookDoc        = "wa_webhook"
	waHookRetryAfter = 30 * time.Minute
	waHookScope      = "webhooks:write"
)

var waHookEvents = []string{"message.received", "message.status"}

// WhatsAppHookURL is this service's public webhook address, empty when no base URL is configured.
func (s *Service) WhatsAppHookURL() string {
	if strings.TrimSpace(s.baseURL) == "" {
		return ""
	}
	return strings.TrimRight(s.baseURL, "/") + "/hooks/whatsapp"
}

func (s *Service) noteWAHook(ctx context.Context, state, reason, id string) {
	now := s.now().UTC().Format(time.RFC3339)
	f := map[string]any{"state": state, "reason": reason, "attempted_at": now}
	if state == "connected" {
		f["webhook_id"], f["at"] = id, now
	}
	if err := s.mergeDoc(ctx, s.db.Pool, waHookDoc, f); err != nil {
		s.log.Warn("whatsapp webhook state", "err", err)
	}
}

// waReason is a short, secret-free reason for a failed call.
func waReason(code int, err error) string {
	if code > 0 {
		return fmt.Sprintf("the platform answered %d", code)
	}
	_ = err // its text may carry the address: say only that it did not answer
	return "unreachable"
}

// EnsureWhatsAppWebhook creates the webhook subscription when GPC-WhatsApp is connected and no
// signing secret is stored yet, and returns the resulting state ("" when nothing was done).
func (s *Service) EnsureWhatsAppWebhook(ctx context.Context) string {
	s.waHookMu.Lock()
	defer s.waHookMu.Unlock()
	if _, _, ok := s.waConnection(ctx); !ok || s.Secrets(ctx)["gpc_whatsapp_webhook_secret"] != "" {
		return ""
	}
	hookURL := s.WhatsAppHookURL()
	if hookURL == "" {
		s.noteWAHook(ctx, "no_url", "this service's public address (PUBLIC_BASE_URL) is not set", "")
		return "no_url"
	}
	fail := func(code int, err error) string {
		s.log.Warn("whatsapp webhook set-up failed", "status", code)
		s.noteWAHook(ctx, "failed", waReason(code, err), "")
		return "failed"
	}
	code, me, err := s.waCall(ctx, http.MethodGet, "/api/v1/me", nil)
	if err != nil {
		return fail(code, err)
	}
	key, _ := me["apiKey"].(map[string]any)
	scopes, _ := key["scopes"].([]any)
	allowed := false
	for _, sc := range scopes {
		if v := str(sc); v == waHookScope || v == "*" {
			allowed = true
		}
	}
	if !allowed {
		s.noteWAHook(ctx, "needs_scope", "the API key lacks the scope "+waHookScope, "")
		return "needs_scope"
	}
	code, list, err := s.waCall(ctx, http.MethodGet, "/api/v1/webhooks", nil)
	if err != nil {
		return fail(code, err)
	}
	// Our own earlier subscription cannot give its secret back: replace it. Only an exact match
	// of our URL; anyone else's webhook is left alone.
	if data, ok := list["data"].([]any); ok {
		for _, d := range data {
			if m, ok := d.(map[string]any); ok && str(m["url"]) == hookURL && str(m["id"]) != "" {
				if code, _, err := s.waCall(ctx, http.MethodDelete, "/api/v1/webhooks/"+url.PathEscape(str(m["id"])), nil); err != nil {
					return fail(code, err)
				}
			}
		}
	}
	code, out, err := s.waCall(ctx, http.MethodPost, "/api/v1/webhooks", map[string]any{"name": "GPC Emailing", "url": hookURL, "events": waHookEvents})
	if err != nil {
		return fail(code, err)
	}
	made, _ := out["data"].(map[string]any)
	id, secret := str(made["id"]), str(made["secret"])
	if secret == "" {
		if id != "" {
			_, _, _ = s.waCall(ctx, http.MethodDelete, "/api/v1/webhooks/"+url.PathEscape(id), nil)
		}
		return fail(0, nil)
	}
	cur, err := s.sealedDoc(ctx, "secrets")
	if err == nil {
		cur["gpc_whatsapp_webhook_secret"] = secret
		err = s.writeSealed(ctx, "secrets", cur)
	}
	if err != nil {
		s.log.Error("whatsapp webhook secret not stored", "err", err)
		s.noteWAHook(ctx, "failed", "the secret could not be stored", "")
		return "failed"
	}
	s.noteWAHook(ctx, "connected", "", id)
	return "connected"
}

// ensureWhatsAppWebhookDue is the worker's step: a retry at most every waHookRetryAfter while
// the webhook is not connected.
func (s *Service) ensureWhatsAppWebhookDue(ctx context.Context) {
	d := s.doc(ctx, waHookDoc)
	if st := str(d["state"]); st == "connected" || st == "manual" {
		return
	}
	if t, err := time.Parse(time.RFC3339, str(d["attempted_at"])); err == nil && s.now().Sub(t) < waHookRetryAfter {
		return
	}
	s.EnsureWhatsAppWebhook(ctx)
}

// WhatsAppHookStatus is what Settings shows about the webhook; it never holds the secret.
func (s *Service) WhatsAppHookStatus(ctx context.Context) map[string]any {
	d := s.doc(ctx, waHookDoc)
	state := str(d["state"])
	if s.Secrets(ctx)["gpc_whatsapp_webhook_secret"] != "" {
		if state != "connected" {
			state = "manual"
		}
	} else if state == "connected" || state == "manual" {
		state = "" // the secret was removed since
	}
	_, _, conn := s.waConnection(ctx)
	return map[string]any{"state": state, "reason": d["reason"], "at": d["at"], "connected": conn}
}
