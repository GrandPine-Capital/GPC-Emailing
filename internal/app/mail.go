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
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/ses"
)

// Mail is Amazon SES (a *ses.Client, or a fake in tests).
type Mail interface {
	Region() string
	Send(ctx context.Context, raw []byte) (string, error)
	Remaining(ctx context.Context) (int, error)
	Account(ctx context.Context) (ses.Account, error)
	Identities(ctx context.Context) ([]ses.Identity, error)
	PollEvents(ctx context.Context, fn func(ses.Event) error) (int, error)
	PollInbound(ctx context.Context, fn func(id string, raw []byte) error) (int, error)
}

// MailConfig is how the service addresses mail.
type MailConfig struct {
	// DefaultFrom sends when neither the campaign nor Settings names an address.
	DefaultFrom string
	// ReplyDomain receives replies (SES inbound): mail from name@grandpine.com carries
	// Reply-To name@<ReplyDomain>; replies are recorded and forwarded to name@grandpine.com.
	ReplyDomain string
	// TransactionalFrom and TransactionalFromName send receipts and other transactional mail
	// (BILLING_FROM, BILLING_FROM_NAME); empty uses the default sender and name.
	TransactionalFrom, TransactionalFromName string
}

// ErrNoMailer: sending is not set up on the server.
var ErrNoMailer = errors.New("sending is not set up on the server (SES_REGION, MAIL_FROM)")

// canSend is nil when mail can go out now: dry-run mode, or SES configured. Queued mail waits
// (rather than failing) otherwise.
func (s *Service) canSend(ctx context.Context) error {
	if s.Settings(ctx).DryRun || s.mail != nil {
		return nil
	}
	return ErrNoMailer
}

// Account is the default sending address.
func (s *Service) Account(ctx context.Context) string {
	if a := strings.ToLower(strings.TrimSpace(s.Settings(ctx).DefaultFromEmail)); a != "" {
		return a
	}
	return s.mailCfg.DefaultFrom
}

func domainOf(addr string) string {
	_, d, _ := strings.Cut(addr, "@")
	return strings.ToLower(d)
}

func localOf(addr string) string {
	l, _, _ := strings.Cut(addr, "@")
	return strings.ToLower(l)
}

// replyAddress is where replies to mail from `from` go: the same name on the reply domain.
func (s *Service) replyAddress(from string) string {
	if s.mailCfg.ReplyDomain == "" || from == "" {
		return ""
	}
	return localOf(from) + "@" + s.mailCfg.ReplyDomain
}

// mapReply turns a reply-domain address back into the sending address it stands for.
func (s *Service) mapReply(ctx context.Context, addr string) string {
	if s.mailCfg.ReplyDomain != "" && domainOf(addr) == s.mailCfg.ReplyDomain {
		return localOf(addr) + "@" + domainOf(s.Account(ctx))
	}
	return addr
}

// MailStatus is shown in Settings.
func (s *Service) MailStatus(ctx context.Context) map[string]any {
	out := map[string]any{"configured": s.mail != nil, "default_from": s.Account(ctx), "reply_domain": s.mailCfg.ReplyDomain}
	if s.mail == nil {
		return out
	}
	out["region"] = s.mail.Region()
	if a, err := s.mail.Account(ctx); err != nil {
		out["error"] = err.Error()
	} else {
		out["account"] = a
	}
	return out
}

// ---------------------------------------------------------------- sender identities

// RefreshSenders reads the verified SES identities into settings/senders.
func (s *Service) RefreshSenders(ctx context.Context) ([]ses.Identity, error) {
	if s.mail == nil {
		return nil, ErrNoMailer
	}
	list, err := s.mail.Identities(ctx)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []ses.Identity{}
	}
	return list, s.mergeDoc(ctx, s.db.Pool, "senders", map[string]any{"list": list, "updated_at": s.now().Format(time.RFC3339)})
}

// senderAllowed: a verified address identity, or any address at a verified domain.
func (s *Service) senderAllowed(ctx context.Context, addr string) bool {
	doc := s.doc(ctx, "senders")
	list, _ := doc["list"].([]any)
	if len(list) == 0 && s.mail != nil {
		if _, err := s.RefreshSenders(ctx); err == nil {
			doc = s.doc(ctx, "senders")
			list, _ = doc["list"].([]any)
		}
	}
	for _, v := range list {
		m, _ := v.(map[string]any)
		id := strings.ToLower(str(m["email"]))
		if truthy(m["verified"]) && (id == addr || id == domainOf(addr)) {
			return true
		}
	}
	return false
}

// ourAddress says whether addr is one of ours (a sender, or a reply-domain address).
func (s *Service) ourAddress(ctx context.Context, addr string) bool {
	return addr != "" && ((s.mailCfg.ReplyDomain != "" && domainOf(addr) == s.mailCfg.ReplyDomain) || addr == s.Account(ctx) || s.senderAllowed(ctx, addr))
}

// RemainingToday is how many more e-mails today allows: the daily limit (UTC day), and what
// SES still allows in its rolling 24 hours.
func (s *Service) RemainingToday(ctx context.Context) int {
	limit := s.Settings(ctx).DailyLimit
	if limit <= 0 {
		limit = 100
	}
	var sent int
	_ = s.db.Pool.QueryRow(ctx, `SELECT coalesce((SELECT sent FROM daily_stats WHERE day = $1), 0)`, dayKey(s.now())).Scan(&sent)
	left := max(0, limit-sent)
	if s.mail != nil {
		if q, err := s.mail.Remaining(ctx); err == nil {
			left = min(left, q)
		}
	}
	return left
}

// ---------------------------------------------------------------- sending

// Outgoing is one e-mail to send.
type Outgoing struct {
	To, ToName, Subject, HTML, Text string
	FromName, FromEmail, ReplyTo    string
	Headers                         map[string]string
	InReplyTo                       string
	// Attachment, when set, goes as message/rfc822 (forwarded replies).
	Attachment []byte
	// Force sends even in dry-run mode (test e-mails, team notifications, forwards).
	Force bool
}

// SendResult is what SES answered.
type SendResult struct {
	ID           string // SES message id
	RFCMessageID string // the Message-ID header the recipient sees
	DryRun       bool
}

// Send sends through SES. From must be a verified identity; Reply-To defaults to the reply
// domain, so replies come back to the app.
func (s *Service) Send(ctx context.Context, m Outgoing) (SendResult, error) {
	st := s.Settings(ctx)
	if st.DryRun && !m.Force {
		return SendResult{ID: "dry-" + randomHex(12), DryRun: true}, nil
	}
	if s.mail == nil {
		return SendResult{}, ErrNoMailer
	}
	m.FromEmail = strings.ToLower(strings.TrimSpace(m.FromEmail))
	if m.FromEmail == "" {
		m.FromEmail = s.Account(ctx)
	}
	if m.FromEmail == "" {
		return SendResult{}, ErrNoMailer
	}
	if !s.senderAllowed(ctx, m.FromEmail) {
		return SendResult{}, fmt.Errorf("%s is not a verified SES sender (Settings → Sender identities)", m.FromEmail)
	}
	if m.FromName == "" {
		m.FromName = st.FromName
	}
	if m.ReplyTo == "" {
		m.ReplyTo = st.ReplyTo
	}
	if m.ReplyTo == "" {
		m.ReplyTo = s.replyAddress(m.FromEmail)
	}
	id, err := s.mail.Send(ctx, BuildMIME(m))
	if err != nil {
		return SendResult{}, err
	}
	return SendResult{ID: id, RFCMessageID: ses.RFCMessageID(s.mail.Region(), id)}, nil
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
		n = `"` + strings.NewReplacer(`"`, "'", `\`, "").Replace(name) + `"`
	}
	return n + " <" + email + ">"
}

func b64Lines(b []byte) string {
	enc := base64.StdEncoding.EncodeToString(b)
	var out strings.Builder
	for len(enc) > 76 {
		out.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	out.WriteString(enc)
	return out.String()
}

// headerSafe drops CR and LF, so no value can start a header of its own.
func headerSafe(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }

// BuildMIME builds the RFC 5322 message: multipart/alternative, inside multipart/mixed when
// there is an attachment.
func BuildMIME(m Outgoing) []byte {
	alt := "a_" + randomHex(12)
	var b bytes.Buffer
	h := func(k, v string) { b.WriteString(k + ": " + headerSafe(v) + "\r\n") }
	h("MIME-Version", "1.0")
	h("From", address(m.FromName, m.FromEmail))
	h("To", address(m.ToName, m.To))
	h("Subject", encodeWord(m.Subject))
	h("Date", time.Now().UTC().Format(time.RFC1123Z))
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
	altPart := func() {
		if m.Text != "" {
			b.WriteString("--" + alt + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64Lines([]byte(m.Text)) + "\r\n")
		}
		if m.HTML != "" {
			b.WriteString("--" + alt + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64Lines([]byte(m.HTML)) + "\r\n")
		}
		b.WriteString("--" + alt + "--")
	}
	if len(m.Attachment) == 0 {
		h("Content-Type", `multipart/alternative; boundary="`+alt+`"`)
		b.WriteString("\r\n")
		altPart()
		return b.Bytes()
	}
	mixed := "m_" + randomHex(12)
	h("Content-Type", `multipart/mixed; boundary="`+mixed+`"`)
	b.WriteString("\r\n--" + mixed + "\r\nContent-Type: multipart/alternative; boundary=\"" + alt + "\"\r\n\r\n")
	altPart()
	b.WriteString("\r\n--" + mixed + "\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=\"original.eml\"\r\n\r\n")
	b.Write(m.Attachment)
	b.WriteString("\r\n--" + mixed + "--")
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
