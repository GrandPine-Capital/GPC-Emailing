package app

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Settings are the workspace settings (Settings → Sender & limits, Integrations), with the
// Firebase build's defaults (Config.js DEFAULT_SETTINGS).
type Settings struct {
	FromName                 string `json:"from_name"`
	ReplyTo                  string `json:"reply_to"`
	CompanyAddress           string `json:"company_address"`
	DailyLimit               int    `json:"daily_limit"`
	PerRunLimit              int    `json:"per_run_limit"`
	DryRun                   bool   `json:"dry_run"`
	CrawlerUserAgent         string `json:"crawler_user_agent"`
	DefaultFromEmail         string `json:"default_from_email"`
	DefaultCountryCode       string `json:"default_country_code"`
	WhatsAppProvider         string `json:"whatsapp_provider"`
	ChatDaddyAccountID       string `json:"chatdaddy_account_id"`
	WhatsAppPhoneNumberID    string `json:"whatsapp_phone_number_id"`
	WhatsAppTemplateLanguage string `json:"whatsapp_template_language"`
	Timezone                 string `json:"timezone"`
}

func defaultSettings() Settings {
	return Settings{
		FromName: "My Company", DailyLimit: 100, PerRunLimit: 40,
		CrawlerUserAgent: "EmailingLeadFinder/1.0 (+GrandPine Capital)", WhatsAppProvider: "chatdaddy",
		ChatDaddyAccountID: "random", WhatsAppTemplateLanguage: "en", Timezone: "Asia/Kuala_Lumpur",
	}
}

// SecretKeys are the integration secrets admins may set; they are stored sealed.
var SecretKeys = []string{"hunter_api_key", "apollo_api_key", "google_cse_key", "google_cse_cx", "chatdaddy_token", "whatsapp_token"}

var textSettings = map[string]bool{
	"from_name": true, "reply_to": true, "company_address": true, "crawler_user_agent": true, "default_from_email": true,
	"default_country_code": true, "timezone": true, "whatsapp_provider": true, "chatdaddy_account_id": true,
	"whatsapp_phone_number_id": true, "whatsapp_template_language": true,
}

// Settings reads the workspace settings over the defaults.
func (s *Service) Settings(ctx context.Context) Settings {
	st := defaultSettings()
	var raw []byte
	err := s.db.Pool.QueryRow(ctx, `SELECT data FROM settings WHERE name = 'app'`).Scan(&raw)
	if err == nil {
		_ = json.Unmarshal(raw, &st)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		s.log.Warn("settings", "err", err)
	}
	return st
}

// doc reads a plain settings document (status, senders, inbox).
func (s *Service) doc(ctx context.Context, name string) map[string]any {
	out := map[string]any{}
	var raw []byte
	if err := s.db.Pool.QueryRow(ctx, `SELECT data FROM settings WHERE name = $1`, name).Scan(&raw); err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

// mergeDoc merges fields into a plain settings document.
func (s *Service) mergeDoc(ctx context.Context, q store.Q, name string, fields map[string]any) error {
	b, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO settings (name, data) VALUES ($1, $2::jsonb)
		ON CONFLICT (name) DO UPDATE SET data = settings.data || EXCLUDED.data, updated_at = now()`, name, string(b))
	return err
}

// sealedDoc reads a sealed settings document (secrets, gmail).
func (s *Service) sealedDoc(ctx context.Context, name string) (map[string]string, error) {
	out := map[string]string{}
	var sealed []byte
	err := s.db.Pool.QueryRow(ctx, `SELECT sealed FROM settings WHERE name = $1`, name).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && len(sealed) == 0) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := s.box.Open(sealed)
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(plain, &out)
}

func (s *Service) writeSealed(ctx context.Context, name string, v map[string]string) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	sealed, err := s.box.Seal(b)
	if err != nil {
		return err
	}
	_, err = s.db.Pool.Exec(ctx, `INSERT INTO settings (name, sealed) VALUES ($1, $2)
		ON CONFLICT (name) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`, name, sealed)
	return err
}

// Secrets are the integration secrets and the webhook secret.
func (s *Service) Secrets(ctx context.Context) map[string]string {
	m, err := s.sealedDoc(ctx, "secrets")
	if err != nil {
		s.log.Error("secrets cannot be read", "err", err)
		return map[string]string{}
	}
	return m
}

// WebhookSecret is the key inbound webhooks must carry, created on first use.
func (s *Service) WebhookSecret(ctx context.Context) (string, error) {
	sec := s.Secrets(ctx)
	if sec["webhook_secret"] != "" {
		return sec["webhook_secret"], nil
	}
	return s.RotateWebhookSecret(ctx)
}

// RotateWebhookSecret replaces the webhook secret; old webhook URLs stop working.
func (s *Service) RotateWebhookSecret(ctx context.Context) (string, error) {
	sec, err := s.sealedDoc(ctx, "secrets")
	if err != nil {
		return "", err
	}
	sec["webhook_secret"] = randomHex(24)
	return sec["webhook_secret"], s.writeSealed(ctx, "secrets", sec)
}

// SettingsView is GET /settings: the settings, worker status, senders and (for admins) secrets
// and webhook URLs.
func (s *Service) SettingsView(ctx context.Context, admin bool) (map[string]any, error) {
	st := s.Settings(ctx)
	out := map[string]any{}
	b, _ := json.Marshal(st)
	_ = json.Unmarshal(b, &out)
	status := s.doc(ctx, "status")
	senders := s.doc(ctx, "senders")
	inbox := s.doc(ctx, "inbox")
	out["status"] = status
	out["inbox"] = orEmpty(inbox["addresses"])
	out["senders"] = orEmpty(senders["list"])
	out["senders_updated_at"] = senders["updated_at"]
	out["can_edit"] = admin
	out["site_url"] = s.baseURL
	out["mail"] = s.MailStatus(ctx)
	for _, k := range SecretKeys {
		out[k] = ""
	}
	out["webhook_secret"] = ""
	out["chatdaddy_webhook_url"], out["generic_webhook_url"] = "", ""
	if admin {
		sec := s.Secrets(ctx)
		for _, k := range SecretKeys {
			out[k] = sec[k]
		}
		hook, err := s.WebhookSecret(ctx)
		if err != nil {
			return nil, err
		}
		out["webhook_secret"] = hook
		out["chatdaddy_webhook_url"] = s.baseURL + "/hook?src=chatdaddy&k=" + hook
		out["generic_webhook_url"] = s.baseURL + "/hook?k=" + hook
	}
	return out, nil
}

func orEmpty(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

// UpdateSettings is PUT /settings (admins).
func (s *Service) UpdateSettings(ctx context.Context, in map[string]any) error {
	app := map[string]any{}
	sec := map[string]string{}
	for k, v := range in {
		switch {
		case contains(SecretKeys, k):
			sec[k] = strings.TrimSpace(str(v))
		case k == "daily_limit" || k == "per_run_limit":
			n, _ := strconv.Atoi(strings.TrimSpace(str(v)))
			app[k] = max(0, n)
		case k == "dry_run":
			app[k] = v == true || v == "true"
		case textSettings[k]:
			app[k] = strings.TrimSpace(str(v))
		}
	}
	if cc, ok := app["default_country_code"].(string); ok {
		app["default_country_code"] = onlyDigits(cc)
	}
	if tz, ok := app["timezone"].(string); ok && tz != "" {
		if _, err := time.LoadLocation(tz); err != nil {
			return userErr("Unknown time zone " + tz + " (use a name such as Asia/Kuala_Lumpur)")
		}
	}
	if err := s.mergeDoc(ctx, s.db.Pool, "app", app); err != nil {
		return err
	}
	if len(sec) > 0 {
		cur, err := s.sealedDoc(ctx, "secrets")
		if err != nil {
			return err
		}
		for k, v := range sec {
			cur[k] = v
		}
		return s.writeSealed(ctx, "secrets", cur)
	}
	return nil
}

// noteStatus merges fields into the worker status document.
func (s *Service) noteStatus(ctx context.Context, fields map[string]any) {
	if err := s.mergeDoc(ctx, s.db.Pool, "status", fields); err != nil {
		s.log.Warn("status", "err", err)
	}
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case json.Number:
		return x.String()
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f
	case json.Number:
		f, _ := x.Float64()
		return f
	}
	return 0
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != "" && x != "false" && x != "0"
	case float64:
		return x != 0
	}
	return v != nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func onlyDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
