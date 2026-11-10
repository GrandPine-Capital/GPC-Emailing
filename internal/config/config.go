// Package config reads the service settings from the environment.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	Env                   string // production | development
	Port                  string
	DatabaseURL           string
	SettingsEncryptionKey string
	// PublicBaseURL is where the app lives. Tracking, click, unsubscribe and image links in
	// e-mails point here, so it must stay stable once mail has gone out.
	PublicBaseURL  string
	AllowedOrigins []string
	AuthMode       string // keycloak | dev
	// The GrandPine staff realm and this app's confidential client in it (AUTH_MODE=keycloak).
	KeycloakIssuer       string
	KeycloakClientID     string
	KeycloakClientSecret string
	// The Google OAuth client an administrator connects the sending Gmail mailbox through
	// (Settings → Gmail). Without it the app runs, but nothing can be sent or read.
	GoogleClientID     string
	GoogleClientSecret string
	// WorkerInterval is how often the background worker sends queued mail, reads the inbox
	// and advances automations. Actions in the app also wake it straight away.
	WorkerInterval time.Duration
	WorkerEnabled  bool
}

func get(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func Load() (Config, error) {
	c := Config{
		Env:                   get("APP_ENV", "production"),
		Port:                  get("PORT", "8080"),
		DatabaseURL:           get("DATABASE_URL", ""),
		SettingsEncryptionKey: get("SETTINGS_ENCRYPTION_KEY", ""),
		PublicBaseURL:         strings.TrimRight(get("PUBLIC_BASE_URL", ""), "/"),
		AuthMode:              get("AUTH_MODE", "keycloak"),
		KeycloakIssuer:        strings.TrimRight(get("KEYCLOAK_ISSUER", ""), "/"),
		KeycloakClientID:      get("KEYCLOAK_CLIENT_ID", ""),
		KeycloakClientSecret:  get("KEYCLOAK_CLIENT_SECRET", ""),
		GoogleClientID:        get("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:    get("GOOGLE_CLIENT_SECRET", ""),
		WorkerEnabled:         get("WORKER_ENABLED", "true") != "false",
	}
	var errs []error
	interval, err := time.ParseDuration(get("WORKER_INTERVAL", "5m"))
	if err != nil || interval < 30*time.Second {
		errs = append(errs, fmt.Errorf("WORKER_INTERVAL must be a duration of at least 30s, e.g. 5m: %q", get("WORKER_INTERVAL", "")))
	}
	c.WorkerInterval = interval
	for _, o := range strings.Split(get("ALLOWED_ORIGINS", c.PublicBaseURL), ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	for name, v := range map[string]string{"DATABASE_URL": c.DatabaseURL, "SETTINGS_ENCRYPTION_KEY": c.SettingsEncryptionKey, "PUBLIC_BASE_URL": c.PublicBaseURL} {
		if v == "" {
			errs = append(errs, fmt.Errorf("%s is required", name))
		}
	}
	if u, err := url.Parse(c.PublicBaseURL); c.PublicBaseURL != "" && (err != nil || u.Host == "" || (c.Env == "production" && u.Scheme != "https")) {
		errs = append(errs, fmt.Errorf("PUBLIC_BASE_URL must be an absolute URL (https in production): %q", c.PublicBaseURL))
	}
	switch c.AuthMode {
	case "keycloak":
		if c.KeycloakIssuer == "" || c.KeycloakClientID == "" || c.KeycloakClientSecret == "" {
			errs = append(errs, errors.New("AUTH_MODE=keycloak needs KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET"))
		} else if u, err := url.Parse(c.KeycloakIssuer); err != nil || u.Host == "" || !strings.Contains(u.Path, "/realms/") {
			errs = append(errs, fmt.Errorf("KEYCLOAK_ISSUER must be the realm URL, e.g. https://vf-iam-prod.grandpine.com/realms/gpc-staff: %q", c.KeycloakIssuer))
		}
	case "dev":
		if c.Env == "production" {
			errs = append(errs, errors.New("AUTH_MODE=dev is not allowed when APP_ENV=production"))
		}
	default:
		errs = append(errs, fmt.Errorf("AUTH_MODE must be keycloak or dev, got %q", c.AuthMode))
	}
	if (c.GoogleClientID == "") != (c.GoogleClientSecret == "") {
		errs = append(errs, errors.New("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together"))
	}
	return c, errors.Join(errs...)
}
