package app

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Auto-reply rules answer new inbox mail (AutoReply.js). They never answer yourself, bounces,
// no-reply senders, mailing lists / newsletters or other auto-responders (RFC 3834).

type inboundMail struct {
	ID, RFCMessageID, From, FromEmail, Subject, Text string
	Date                                             time.Time
	Recipients                                       []string
	Header                                           func(string) string
}

type autoReplyRule struct {
	ID            string         `db:"id"`
	Name          string         `db:"name"`
	ToAddress     string         `db:"to_address"`
	Audience      string         `db:"audience"`
	Keywords      string         `db:"keywords"`
	Exclude       string         `db:"exclude"`
	TemplateID    string         `db:"template_id"`
	KeepThread    bool           `db:"keep_thread"`
	FromMode      string         `db:"from_mode"`
	FromEmail     string         `db:"from_email"`
	CooldownHours int            `db:"cooldown_hours"`
	Schedule      map[string]any `db:"schedule"`
	Timezone      string         `db:"timezone"`
	CreateContact bool           `db:"create_contact"`
	ListID        string         `db:"list_id"`
	Tags          string         `db:"tags"`
	NotifyEmail   string         `db:"notify_email"`
}

type autoReplyResult struct{ Status, Rule, Reason string }

var (
	skipSenderRe = regexp.MustCompile(`(?i)(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([._-]|@)`)
	precedenceRe = regexp.MustCompile(`(?i)^(bulk|list|junk|auto_reply)$`)
	prefixRe     = regexp.MustCompile(`(?i)^\s*(re|aw|fw|fwd)\s*:\s*`)
)

// isAutomated says why a message is itself automated ("" when a person sent it).
func isAutomated(m inboundMail) string {
	h := m.Header
	if auto := strings.ToLower(h("Auto-Submitted")); auto != "" && auto != "no" {
		return "auto-submitted"
	}
	if precedenceRe.MatchString(strings.TrimSpace(h("Precedence"))) {
		return "bulk/list mail"
	}
	if h("List-Id") != "" || h("List-Unsubscribe") != "" {
		return "mailing list or newsletter"
	}
	if h("X-Autoreply") != "" || h("X-Autorespond") != "" || h("X-Auto-Response-Suppress") != "" {
		return "auto-responder"
	}
	if skipSenderRe.MatchString(m.FromEmail) {
		return "no-reply sender"
	}
	return ""
}

// inSchedule: always, or only inside / outside office hours in the rule's time zone.
func inSchedule(r autoReplyRule, at time.Time, fallbackTZ string) bool {
	mode := str(r.Schedule["mode"])
	if mode == "" || mode == "always" {
		return true
	}
	tz := r.Timezone
	if tz == "" {
		tz = fallbackTZ
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	local := at.In(loc)
	day := int(local.Weekday())
	if day == 0 {
		day = 7 // ISO: Monday 1 … Sunday 7
	}
	days := []int{1, 2, 3, 4, 5}
	if list, ok := r.Schedule["days"].([]any); ok && len(list) > 0 {
		days = days[:0]
		for _, d := range list {
			days = append(days, int(num(d)))
		}
	}
	start, end := str(r.Schedule["start"]), str(r.Schedule["end"])
	if start == "" {
		start = "09:00"
	}
	if end == "" {
		end = "18:00"
	}
	hhmm := local.Format("15:04")
	open := false
	for _, d := range days {
		if d == day {
			open = hhmm >= start && hhmm < end
		}
	}
	if mode == "inside" {
		return open
	}
	return !open
}

// mismatch says why a rule does not apply ("" when it does).
func mismatch(r autoReplyRule, m inboundMail, isContact bool, tz string) string {
	if r.ToAddress != "" && !contains(m.Recipients, strings.ToLower(r.ToAddress)) {
		return "sent to another address"
	}
	if r.Audience == "new" && isContact {
		return "sender is already a contact"
	}
	if r.Audience == "contacts" && !isContact {
		return "sender is not a contact"
	}
	for _, w := range core.Words(r.Exclude) {
		if strings.Contains(m.FromEmail, w) {
			return "sender excluded"
		}
	}
	if kw := core.Words(r.Keywords); len(kw) > 0 {
		text := strings.ToLower(m.Subject + "\n" + m.Text)
		hit := false
		for _, w := range kw {
			if strings.Contains(text, w) {
				hit = true
				break
			}
		}
		if !hit {
			return "no keyword match"
		}
	}
	if !inSchedule(r, m.Date, tz) {
		return "outside the rule schedule"
	}
	return ""
}

func nameParts(from string) (first, last string) {
	name := strings.TrimSpace(strings.ReplaceAll(regexp.MustCompile(`<[^>]*>`).ReplaceAllString(from, ""), `"`, ""))
	if name == "" || strings.Contains(name, "@") {
		return "", ""
	}
	parts := strings.Fields(name)
	return parts[0], strings.Join(parts[1:], " ")
}

// autoReply evaluates the enabled rules, in order, for one inbound message.
func (s *Service) autoReply(ctx context.Context, m inboundMail) autoReplyResult {
	rules, err := store.Structs[autoReplyRule](ctx, s.db.Pool, `SELECT * FROM autoreplies WHERE enabled ORDER BY sort_order, created_at`)
	if err != nil {
		return autoReplyResult{Status: "error", Reason: err.Error()}
	}
	if len(rules) == 0 {
		return autoReplyResult{Status: "no_rule", Reason: "no auto-reply rules enabled"}
	}
	if why := isAutomated(m); why != "" {
		return autoReplyResult{Status: "skipped", Reason: why}
	}
	contact, err := s.contact(ctx, s.db.Pool, core.EmailKey(m.FromEmail))
	if err != nil && !IsNotFound(err) {
		return autoReplyResult{Status: "error", Reason: err.Error()}
	}
	tz := s.Settings(ctx).Timezone
	last := ""
	for _, r := range rules {
		if why := mismatch(r, m, contact != nil, tz); why != "" {
			last = r.Name + ": " + why
			continue
		}
		hours := max(1, r.CooldownHours)
		recent, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM inbound WHERE autoreply_rule = $1 AND from_email = $2 AND replied_at >= $3`,
			r.ID, m.FromEmail, s.now().Add(-time.Duration(hours)*time.Hour))
		if err != nil {
			return autoReplyResult{Status: "error", Rule: r.ID, Reason: err.Error()}
		}
		if recent > 0 {
			return autoReplyResult{Status: "skipped", Rule: r.ID, Reason: "already auto-replied to this sender recently"}
		}
		if s.RemainingToday(ctx) <= 0 {
			return autoReplyResult{Status: "skipped", Rule: r.ID, Reason: "daily sending limit reached"}
		}
		t, err := s.template(ctx, r.TemplateID)
		if err != nil {
			return autoReplyResult{Status: "skipped", Rule: r.ID, Reason: "template missing"}
		}
		first, lastName := nameParts(m.From)
		person := map[string]string{"email": m.FromEmail, "first_name": first, "last_name": lastName}
		if contact != nil {
			for k, v := range contact.Fields() {
				if v != "" {
					person[k] = v
				}
			}
		}
		base := prefixRe.ReplaceAllString(m.Subject, "")
		subject := t.Subject
		if r.KeepThread {
			if base == "" {
				base = t.Subject
			}
			subject = "Re: " + base
		} else if subject == "" {
			subject = "Re: " + base
		}
		built, err := s.buildEmail(ctx, buildOpts{HTML: t.HTML, Subject: subject, Vars: person, Token: "auto", NoUnsubscribe: true})
		if err != nil {
			return autoReplyResult{Status: "error", Rule: r.ID, Reason: err.Error()}
		}
		out := Outgoing{To: m.FromEmail, ToName: core.FullName(person["first_name"], person["last_name"]), Subject: built.Subject, HTML: built.HTML, Text: built.Text,
			Headers: map[string]string{"Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All"}}
		switch {
		case r.FromMode == "custom" && r.FromEmail != "":
			out.FromEmail = r.FromEmail
		case r.FromMode == "default":
		default: // reply from the address they wrote to, when it is one of ours
			for _, a := range m.Recipients {
				if s.senderAllowed(ctx, a) {
					out.FromEmail = a
					break
				}
			}
		}
		if r.KeepThread {
			out.InReplyTo = m.RFCMessageID
		}
		if _, err := s.Send(ctx, out); err != nil {
			return autoReplyResult{Status: "error", Rule: r.ID, Reason: err.Error()}
		}
		s.bumpDaily(ctx, s.db.Pool, "sent", 1)
		_, _ = s.db.Pool.Exec(ctx, `UPDATE autoreplies SET last_replied_at = $2, replied_count = replied_count + 1 WHERE id = $1`, r.ID, s.now())

		if r.CreateContact || r.ListID != "" || strings.TrimSpace(r.Tags) != "" {
			if _, err := s.UpsertInboundContact(ctx, InboundContact{Email: m.FromEmail, FirstName: first, LastName: lastName, Source: "email",
				Tags: core.SplitTags(r.Tags), ListID: r.ListID}); err != nil {
				s.log.Warn("auto-reply contact", "err", err)
			}
		}
		if r.NotifyEmail != "" {
			subj := m.Subject
			if subj == "" {
				subj = "(no subject)"
			}
			if _, err := s.Send(ctx, Outgoing{To: r.NotifyEmail, Force: true, Subject: "[Auto-reply] " + m.FromEmail + ": " + subj,
				Text: "Rule \"" + r.Name + "\" auto-replied to " + m.From + ".\n\nTheir message:\n" + core.Truncate(m.Text, 3000)}); err != nil {
				s.log.Warn("auto-reply notify", "err", err)
			}
		}
		return autoReplyResult{Status: "replied", Rule: r.ID, Reason: r.Name}
	}
	if last == "" {
		last = "no rule matched"
	}
	return autoReplyResult{Status: "skipped", Reason: last}
}
