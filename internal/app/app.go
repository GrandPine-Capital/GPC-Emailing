// Package app is the e-mail marketing service: contacts, templates, campaigns, tracking,
// replies, automations, auto-replies, webhooks and the lead finder, over one Postgres
// database, sending through Amazon SES and receiving replies on the SES reply domain.
//
// It is the Go port of the Firebase build's Apps Script worker (apps-script/*.js) and of the
// Firestore logic that ran in the browser (hosting/js/backend.js); the comments name the
// behaviour each part keeps.
package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/secretbox"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Service is the application. One per process; safe for concurrent use.
type Service struct {
	db      *store.DB
	box     *secretbox.Box
	log     *slog.Logger
	baseURL string // PUBLIC_BASE_URL
	mail    Mail   // nil: SES not configured (dry-run only)
	mailCfg MailConfig
	hmacKey []byte

	// HTTP is used for WhatsApp providers; Outbound for user-given URLs (webhooks, the lead
	// crawler), which refuses private and link-local addresses.
	HTTP     *http.Client
	Outbound *http.Client
	// Now is the clock (tests move it).
	Now func() time.Time

	wake chan struct{}
}

// New builds the service. secretKey is SETTINGS_ENCRYPTION_KEY (base64); link keys are signed
// with a key derived from it. mail is nil when SES is not configured.
func New(db *store.DB, box *secretbox.Box, secretKey, baseURL string, mail Mail, mailCfg MailConfig, log *slog.Logger) *Service {
	k := sha256.Sum256([]byte("gpc-emailing/hmac/" + secretKey))
	return &Service{
		db: db, box: box, log: log, baseURL: baseURL, mail: mail, mailCfg: mailCfg, hmacKey: k[:],
		HTTP:     &http.Client{Timeout: 30 * time.Second},
		Outbound: SafeClient(30 * time.Second),
		Now:      func() time.Time { return time.Now().UTC() },
		wake:     make(chan struct{}, 1),
	}
}

func (s *Service) DB() *store.DB   { return s.db }
func (s *Service) BaseURL() string { return s.baseURL }

// sign is a 24-hex HMAC of value (link keys, as hmac() in Config.js).
func (s *Service) sign(value string) string {
	m := hmac.New(sha256.New, s.hmacKey)
	m.Write([]byte(value))
	return hex.EncodeToString(m.Sum(nil))[:24]
}

// Wake asks the worker to run now instead of at its next interval.
func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------- errors the API maps

// UserError is a request the service refuses, with a message for the person (HTTP 400).
type UserError struct{ Msg string }

func (e UserError) Error() string { return e.Msg }

func userErr(msg string) error { return UserError{msg} }

// ErrForbidden is a write the caller's role may not make (HTTP 403).
type ErrForbidden struct{ Msg string }

func (e ErrForbidden) Error() string { return e.Msg }

// IsNotFound reports a missing record.
func IsNotFound(err error) bool { return errors.Is(err, store.ErrNotFound) }

// ---------------------------------------------------------------- small helpers

func (s *Service) now() time.Time { return s.Now() }

func dayKey(t time.Time) string { return t.UTC().Format("2006-01-02") }

// bumpDaily adds to today's dashboard counter (sent, opens, clicks, replies).
func (s *Service) bumpDaily(ctx context.Context, q store.Q, field string, n int) {
	switch field {
	case "sent", "opens", "clicks", "replies":
	default:
		return
	}
	_, err := q.Exec(ctx, `INSERT INTO daily_stats (day, `+field+`) VALUES ($1, $2)
		ON CONFLICT (day) DO UPDATE SET `+field+` = daily_stats.`+field+` + EXCLUDED.`+field, dayKey(s.now()), n)
	if err != nil {
		s.log.Warn("daily stats", "err", err)
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func nilIfEmpty(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
