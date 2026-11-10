package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/gmail"
)

// Mailbox is the connected Gmail mailbox (a *gmail.Client, or a fake in tests).
type Mailbox interface {
	Send(ctx context.Context, raw []byte, threadID string) (id, thread string, err error)
	MessageIDHeader(ctx context.Context, id string) (string, error)
	List(ctx context.Context, query string, max int) ([]gmail.Ref, error)
	Get(ctx context.Context, id string) (*gmail.Message, error)
	SendAsList(ctx context.Context) ([]gmail.SendAs, error)
}

// ErrNoMailbox: nothing can be sent or read until an administrator connects Gmail.
var ErrNoMailbox = errors.New("Gmail is not connected: an administrator connects it in Settings → Gmail")

// mailbox is the connected mailbox and its address.
func (s *Service) mailbox(ctx context.Context) (Mailbox, string, error) {
	if s.MailboxOverride != nil {
		g, _ := s.sealedDoc(ctx, "gmail")
		account := g["email"]
		if account == "" {
			account = "worker@example.com"
		}
		return s.MailboxOverride, account, nil
	}
	g, err := s.sealedDoc(ctx, "gmail")
	if err != nil {
		return nil, "", err
	}
	if g["refresh_token"] == "" || !s.google.Configured() {
		return nil, "", ErrNoMailbox
	}
	s.mbMu.Lock()
	defer s.mbMu.Unlock()
	if s.mb == nil || s.mbToken != g["refresh_token"] {
		s.mb, s.mbToken = s.google.Client(g["refresh_token"]), g["refresh_token"]
	}
	return s.mb, g["email"], nil
}

// canSend is nil when mail can go out now: dry-run mode, or a connected mailbox. Queued mail
// waits (rather than failing) while Gmail is not connected.
func (s *Service) canSend(ctx context.Context) error {
	if s.Settings(ctx).DryRun {
		return nil
	}
	_, _, err := s.mailbox(ctx)
	return err
}

// Account is the connected mailbox's address ("" when not connected).
func (s *Service) Account(ctx context.Context) string {
	_, account, err := s.mailbox(ctx)
	if err != nil {
		return ""
	}
	return account
}

// GmailStatus is shown in Settings.
func (s *Service) GmailStatus(ctx context.Context) (map[string]any, error) {
	g, err := s.sealedDoc(ctx, "gmail")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"configured":   s.google.Configured(),
		"connected":    g["refresh_token"] != "",
		"email":        g["email"],
		"connected_at": g["connected_at"],
		"connected_by": g["connected_by"],
	}, nil
}

// GmailConnectURL starts the consent flow. The state is signed and expires, so the callback
// (which carries no sign-in) only accepts a flow an administrator started here.
func (s *Service) GmailConnectURL(by string) (string, error) {
	if !s.google.Configured() {
		return "", userErr("No Google OAuth client is set up on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")
	}
	exp := strconv.FormatInt(s.now().Add(15*time.Minute).Unix(), 10)
	payload := base64.RawURLEncoding.EncodeToString([]byte(exp + "|" + by))
	return s.google.AuthURL(payload+"."+s.sign("gmail-state:"+payload), ""), nil
}

// GmailCallback finishes the consent flow and stores the mailbox's refresh token.
func (s *Service) GmailCallback(ctx context.Context, code, state string) (string, error) {
	payload, sig, ok := strings.Cut(state, ".")
	if !ok || sig != s.sign("gmail-state:"+payload) {
		return "", userErr("This Gmail connection link is invalid. Start again from Settings.")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(payload)
	exp, by, _ := strings.Cut(string(raw), "|")
	if n, _ := strconv.ParseInt(exp, 10, 64); s.now().Unix() > n {
		return "", userErr("This Gmail connection link has expired. Start again from Settings.")
	}
	client, refresh, err := s.google.Exchange(ctx, code)
	if err != nil {
		return "", err
	}
	email, err := client.Profile(ctx)
	if err != nil {
		return "", err
	}
	if err := s.writeSealed(ctx, "gmail", map[string]string{
		"refresh_token": refresh, "email": email, "connected_at": s.now().Format(time.RFC3339), "connected_by": by,
	}); err != nil {
		return "", err
	}
	s.log.Info("gmail connected", "mailbox", email, "by", by)
	if _, err := s.RefreshSenders(ctx); err != nil {
		s.log.Warn("could not read Send mail as addresses", "err", err)
	}
	s.Wake()
	return email, nil
}

// DisconnectGmail forgets the mailbox; sending and inbox reading stop.
func (s *Service) DisconnectGmail(ctx context.Context) error {
	_, err := s.db.Pool.Exec(ctx, `DELETE FROM settings WHERE name = 'gmail'`)
	return err
}

// ---------------------------------------------------------------- sender identities

// RefreshSenders reads the mailbox's "Send mail as" addresses into settings/senders.
func (s *Service) RefreshSenders(ctx context.Context) ([]gmail.SendAs, error) {
	mb, _, err := s.mailbox(ctx)
	if err != nil {
		return nil, err
	}
	list, err := mb.SendAsList(ctx)
	if err != nil {
		return nil, err
	}
	return list, s.mergeDoc(ctx, s.db.Pool, "senders", map[string]any{"list": list, "updated_at": s.now().Format(time.RFC3339)})
}

// allowedSenders are the verified addresses the mailbox may send as (the account itself first).
func (s *Service) allowedSenders(ctx context.Context, account string) (emails []string, names map[string]string) {
	emails = []string{strings.ToLower(account)}
	names = map[string]string{}
	doc := s.doc(ctx, "senders")
	list, _ := doc["list"].([]any)
	for _, v := range list {
		m, _ := v.(map[string]any)
		e := strings.ToLower(str(m["email"]))
		names[e] = str(m["name"])
		if truthy(m["verified"]) && e != "" && !contains(emails, e) {
			emails = append(emails, e)
		}
	}
	return emails, names
}

// resolveFrom picks the From address: the account, or one of its verified Send-mail-as
// addresses. Anything else is refused (Gmail would rewrite or reject it).
func (s *Service) resolveFrom(ctx context.Context, account, requested string) (email, name string, err error) {
	account = strings.ToLower(account)
	want := strings.ToLower(strings.TrimSpace(requested))
	if want == "" || want == account {
		return account, "", nil
	}
	emails, names := s.allowedSenders(ctx, account)
	if !contains(emails, want) {
		return "", "", fmt.Errorf("%s is not a verified \"Send mail as\" address of %s (Settings → Sender identities)", want, account)
	}
	return want, names[want], nil
}

// RemainingToday is how many more e-mails the daily limit allows today (UTC day).
func (s *Service) RemainingToday(ctx context.Context) int {
	limit := s.Settings(ctx).DailyLimit
	if limit <= 0 {
		limit = 100
	}
	var sent int
	_ = s.db.Pool.QueryRow(ctx, `SELECT coalesce((SELECT sent FROM daily_stats WHERE day = $1), 0)`, dayKey(s.now())).Scan(&sent)
	return max(0, limit-sent)
}

// ---------------------------------------------------------------- sending

// Outgoing is one e-mail to send.
type Outgoing struct {
	To, ToName, Subject, HTML, Text string
	FromName, FromEmail, ReplyTo    string
	Headers                         map[string]string
	ThreadID, InReplyTo             string
	// Force sends even in dry-run mode (test e-mails and team notifications).
	Force bool
}

// SendResult is what Gmail answered.
type SendResult struct {
	ID, ThreadID string
	DryRun       bool
}

// Send sends through the connected mailbox (Mailer.send in Mailer.js).
func (s *Service) Send(ctx context.Context, m Outgoing) (SendResult, error) {
	st := s.Settings(ctx)
	if st.DryRun && !m.Force {
		return SendResult{ID: "dry-" + randomHex(12), ThreadID: "dry-" + randomHex(12), DryRun: true}, nil
	}
	mb, account, err := s.mailbox(ctx)
	if err != nil {
		return SendResult{}, err
	}
	if m.FromEmail == "" {
		m.FromEmail = st.DefaultFromEmail
	}
	from, aliasName, err := s.resolveFrom(ctx, account, m.FromEmail)
	if err != nil {
		return SendResult{}, err
	}
	m.FromEmail = from
	if m.FromName == "" {
		m.FromName = aliasName
	}
	if m.FromName == "" {
		m.FromName = st.FromName
	}
	if m.ReplyTo == "" {
		m.ReplyTo = st.ReplyTo
	}
	id, thread, err := mb.Send(ctx, BuildMIME(m), m.ThreadID)
	if err != nil {
		return SendResult{}, err
	}
	return SendResult{ID: id, ThreadID: thread}, nil
}

var printable = regexp.MustCompile(`^[\x20-\x7e]*$`)

func encodeWord(s string) string {
	if printable.MatchString(s) {
		return s
	}
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
}

func address(name, email string) string {
	if name == "" {
		return email
	}
	n := encodeWord(name)
	if printable.MatchString(name) {
		n = `"` + strings.ReplaceAll(name, `"`, "'") + `"`
	}
	return n + " <" + email + ">"
}

func b64Lines(s string) string {
	enc := base64.StdEncoding.EncodeToString([]byte(s))
	var b strings.Builder
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc)
	return b.String()
}

// headerSafe drops CR and LF, so no value can start a header of its own.
func headerSafe(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }

// BuildMIME builds the RFC 2822 multipart/alternative message (buildMime in Mailer.js).
func BuildMIME(m Outgoing) []byte {
	boundary := "b_" + randomHex(12)
	var b bytes.Buffer
	h := func(k, v string) { b.WriteString(k + ": " + headerSafe(v) + "\r\n") }
	h("MIME-Version", "1.0")
	h("From", address(m.FromName, m.FromEmail))
	h("To", address(m.ToName, m.To))
	h("Subject", encodeWord(m.Subject))
	if m.ReplyTo != "" {
		h("Reply-To", m.ReplyTo)
	}
	if m.InReplyTo != "" {
		h("In-Reply-To", m.InReplyTo)
		h("References", m.InReplyTo)
	}
	keys := make([]string, 0, len(m.Headers))
	for k := range m.Headers {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		h(k, m.Headers[k])
	}
	h("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	if m.Text != "" {
		b.WriteString("--" + boundary + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64Lines(m.Text) + "\r\n")
	}
	if m.HTML != "" {
		b.WriteString("--" + boundary + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64Lines(m.HTML) + "\r\n")
	}
	b.WriteString("--" + boundary + "--")
	return b.Bytes()
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func sortStrings(a []string) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
