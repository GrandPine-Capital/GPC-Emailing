package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
)

// WhatsApp for automations goes through GPC-WhatsApp (the company's own platform, the default),
// or, kept one release as a fallback, ChatDaddy (https://api.chatdaddy.tech/im) or the WhatsApp
// Cloud API (Meta), as Integrations.js.
var (
	ChatDaddyAPI = "https://api.chatdaddy.tech/im"
	GraphAPI     = "https://graph.facebook.com/v21.0"
)

// WhatsAppOpts is one WhatsApp message: free text, or (Cloud API) an approved template.
type WhatsAppOpts struct {
	Provider, Text, Template, Language string
	Params                             []string
	// Ref and IdempotencyKey are for GPC-WhatsApp: the caller's own reference (the automation run
	// id) and a key that is the same for every retry of the same send, so it goes out once.
	Ref, IdempotencyKey string
}

// WhatsApp providers (setting whatsapp_provider). Unset or empty means ProviderGPC.
const (
	ProviderGPC       = "gpc_whatsapp"
	ProviderChatDaddy = "chatdaddy"
	ProviderCloud     = "cloud"
)

// WhatsAppError is a failed GPC-WhatsApp send. Temporary ones (daily limit, platform down) are
// worth trying again later; the others (opted out, 24 h window closed, channel disconnected,
// a wrong request) would fail the same way again.
type WhatsAppError struct {
	Err       error
	Temporary bool
}

func (e *WhatsAppError) Error() string { return e.Err.Error() }
func (e *WhatsAppError) Unwrap() error { return e.Err }

// whatsAppProvider is the provider a send uses: the step's own choice, else the setting, else GPC-WhatsApp.
func (s *Service) whatsAppProvider(ctx context.Context, chosen string) string {
	if chosen == "" {
		chosen = s.Settings(ctx).WhatsAppProvider
	}
	if chosen == "" {
		return ProviderGPC
	}
	return chosen
}

func (s *Service) contactPhone(ctx context.Context, c *Contact) string {
	if c.PhoneKey != "" {
		return c.PhoneKey
	}
	return c.Phone
}

func (s *Service) callJSON(ctx context.Context, method, url, token string, body any, name string) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return fmt.Errorf("%s error %d: %s", name, res.StatusCode, strings.TrimSpace(string(data)))
	}
	return nil
}

// sendGPCWhatsApp sends through GPC-WhatsApp (POST /api/v1/messages) with the connection payment
// notices use, and returns the platform's message id.
func (s *Service) sendGPCWhatsApp(ctx context.Context, st Settings, to string, o WhatsAppOpts) (string, error) {
	channel := strings.TrimSpace(st.GPCWhatsAppChannel)
	if o.Template != "" && channel == "personal" {
		return "", errors.New("Templates go from a WABA number: choose a WABA channel in Settings → Integrations (or send a text)")
	}
	body := map[string]any{"to": to}
	if channel != "" {
		body["channelId"] = channel // empty: the platform uses the company's default number
	}
	if o.Ref != "" {
		body["ref"] = core.Truncate(o.Ref, 200)
	}
	if o.IdempotencyKey != "" {
		body["idempotencyKey"] = o.IdempotencyKey
	}
	if o.Template != "" {
		lang := o.Language
		if lang == "" {
			lang = st.WhatsAppTemplateLanguage
		}
		tpl := map[string]any{"name": o.Template, "language": lang}
		if len(o.Params) > 0 {
			params := []any{}
			for _, p := range o.Params {
				params = append(params, map[string]any{"type": "text", "text": p})
			}
			tpl["components"] = []any{map[string]any{"type": "body", "parameters": params}}
		}
		body["type"], body["template"] = "template", tpl
	} else {
		body["type"], body["text"] = "text", o.Text
	}
	code, out, err := s.waCall(ctx, http.MethodPost, "/api/v1/messages", body)
	switch {
	case err == nil:
		if str(out["status"]) == "failed" {
			return "", &WhatsAppError{Err: fmt.Errorf("GPC WhatsApp: %s", str(out["error"]))}
		}
		return str(out["messageId"]), nil
	case errors.Is(err, errWhatsAppOff):
		return "", err
	case code == http.StatusTooManyRequests || code >= 500 || code == 0:
		return "", &WhatsAppError{Err: err, Temporary: true} // daily limit, platform down or unreachable
	default:
		return "", &WhatsAppError{Err: err} // 409 (opted out, 24 h window, channel off) and a wrong request
	}
}

// SendWhatsApp sends with the chosen provider (or the workspace default). It returns the message
// id when the provider gives one (GPC-WhatsApp).
func (s *Service) SendWhatsApp(ctx context.Context, phone string, o WhatsAppOpts) (string, error) {
	st := s.Settings(ctx)
	to := core.PhoneKey(phone, st.DefaultCountryCode)
	if to == "" {
		return "", errors.New("contact has no valid phone number")
	}
	provider := s.whatsAppProvider(ctx, o.Provider)
	if provider == ProviderGPC {
		return s.sendGPCWhatsApp(ctx, st, to, o)
	}
	sec := s.Secrets(ctx)
	if provider == ProviderCloud {
		if sec["whatsapp_token"] == "" || st.WhatsAppPhoneNumberID == "" {
			return "", errors.New("WhatsApp Cloud API is not configured (Settings → Integrations)")
		}
		body := map[string]any{"messaging_product": "whatsapp", "to": to}
		if o.Template != "" {
			lang := o.Language
			if lang == "" {
				lang = st.WhatsAppTemplateLanguage
			}
			tpl := map[string]any{"name": o.Template, "language": map[string]string{"code": lang}}
			if len(o.Params) > 0 {
				params := []map[string]string{}
				for _, p := range o.Params {
					params = append(params, map[string]string{"type": "text", "text": p})
				}
				tpl["components"] = []map[string]any{{"type": "body", "parameters": params}}
			}
			body["type"], body["template"] = "template", tpl
		} else {
			body["type"], body["text"] = "text", map[string]any{"body": o.Text, "preview_url": true}
		}
		return "", s.callJSON(ctx, http.MethodPost, GraphAPI+"/"+url.PathEscape(st.WhatsAppPhoneNumberID)+"/messages", sec["whatsapp_token"], body, "WhatsApp")
	}
	if sec["chatdaddy_token"] == "" {
		return "", errors.New("ChatDaddy API token is not set (Settings → Integrations)")
	}
	account := st.ChatDaddyAccountID
	if account == "" {
		account = "random"
	}
	return "", s.callJSON(ctx, http.MethodPost, ChatDaddyAPI+"/messages/"+url.PathEscape(account)+"/"+url.PathEscape(to), sec["chatdaddy_token"], map[string]string{"text": o.Text}, "ChatDaddy")
}

// chatdaddyUpsert creates or updates the contact in ChatDaddy (by phone) with tags.
func (s *Service) chatdaddyUpsert(ctx context.Context, c *Contact, tags []string) error {
	token := s.Secrets(ctx)["chatdaddy_token"]
	if token == "" {
		return errors.New("ChatDaddy API token is not set (Settings → Integrations)")
	}
	to := core.PhoneKey(s.contactPhone(ctx, c), s.Settings(ctx).DefaultCountryCode)
	if to == "" {
		return errors.New("contact has no valid phone number")
	}
	name := c.Name()
	if name == "" {
		name = c.Company
	}
	if name == "" {
		name = to
	}
	tagList := []map[string]string{}
	for _, t := range tags {
		if t != "" {
			tagList = append(tagList, map[string]string{"name": t})
		}
	}
	cd := map[string]any{"phoneNumber": to, "name": name, "tags": tagList}
	if c.Email != "" {
		cd["email"] = c.Email
	}
	return s.callJSON(ctx, http.MethodPost, ChatDaddyAPI+"/contacts/upsert", token, map[string]any{"contacts": []any{cd}}, "ChatDaddy")
}

// logWhatsApp keeps a WhatsApp message on the contact's timeline. With the platform's message id
// the row is wa-<id>, as incoming ones are, and is kept once however often it is logged.
func (s *Service) logWhatsApp(ctx context.Context, c *Contact, direction, text, automationID string, messageID ...string) {
	id := ids.New()
	if len(messageID) > 0 && messageID[0] != "" {
		id = "wa-" + messageID[0]
	}
	_, err := s.db.Pool.Exec(ctx, `INSERT INTO whatsapp (id, contact_id, phone, direction, text, automation_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
		id, c.ID, core.PhoneKey(s.contactPhone(ctx, c), s.Settings(ctx).DefaultCountryCode), direction, core.Truncate(text, 4000), nilIfEmpty(automationID), s.now())
	if err != nil {
		s.log.Warn("whatsapp log", "err", err)
	}
}

// SafeClient is an HTTP client that only connects to public addresses: webhook steps and the
// lead crawler fetch URLs people type or search engines return, which must not reach the VPC,
// the instance metadata service or localhost.
func SafeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if ip == nil || !publicIP(ip) {
			return fmt.Errorf("refusing to connect to non-public address %s", host)
		}
		return nil
	}}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConnsPerHost:   2,
	}
	return &http.Client{Timeout: timeout, Transport: tr, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}}
}

func publicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	// 100.64.0.0/10 (carrier-grade NAT) and 0.0.0.0/8 are not public either.
	if v4 := ip.To4(); v4 != nil && (v4[0] == 0 || (v4[0] == 100 && v4[1]&0xc0 == 64)) {
		return false
	}
	return true
}
