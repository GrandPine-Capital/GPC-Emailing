package app

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/gmail"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// IncomingReply is a reply to record (from the inbox, or logged by hand).
type IncomingReply struct {
	ID, ThreadID, From, Subject, Text string
	Date                              time.Time
}

// RecordReply stores a reply, links it to the message it answers (by Gmail thread, else the
// contact's latest sent message) and fires reply_received. Nil when the sender is not a
// contact or the reply was already stored (Replies.record).
func (s *Service) RecordReply(ctx context.Context, r IncomingReply) (map[string]any, error) {
	fromEmail := core.AddressOf(r.From)
	if fromEmail == "" || fromEmail == strings.ToLower(s.Account(ctx)) {
		return nil, nil
	}
	var msg *Message
	if r.ThreadID != "" {
		if m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE thread_id = $1 ORDER BY sent_at DESC NULLS LAST LIMIT 1`, r.ThreadID); err == nil {
			msg = &m
		}
	}
	var contactID string
	if msg != nil {
		contactID = msg.ContactID
	} else {
		contactID = core.EmailKey(fromEmail)
	}
	c, err := s.contact(ctx, s.db.Pool, contactID)
	if IsNotFound(err) {
		return nil, nil // not someone we e-mailed
	} else if err != nil {
		return nil, err
	}
	if msg == nil {
		if m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE contact_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, c.ID); err == nil {
			msg = &m
		}
	}
	body := core.Truncate(core.StripQuoted(r.Text), 20000)
	id := r.ID
	if id == "" {
		id = ids.New()
	}
	received := r.Date
	if received.IsZero() {
		received = s.now()
	}
	var msgID, campID, campName, origSubject *string
	if msg != nil {
		msgID, campID, campName, origSubject = &msg.ID, msg.CampaignID, msg.CampaignName, &msg.Subject
	}
	tag, err := s.db.Pool.Exec(ctx, `INSERT INTO replies (id, channel, contact_id, message_id, campaign_id, campaign_name, original_subject, from_email,
		first_name, last_name, company, subject, body, received_at, created_at) VALUES ($1,'email',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (id) DO NOTHING`, id, c.ID, msgID, campID, campName, origSubject, fromEmail, c.FirstName, c.LastName, c.Company, r.Subject, body, received, s.now())
	if err != nil {
		return nil, store.MapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, nil // duplicate
	}
	now := s.now()
	if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET replied_at = $2 WHERE id = $1`, c.ID, now); err != nil {
		return nil, err
	}
	if msg != nil {
		err := s.db.InTx(ctx, func(tx pgx.Tx) error {
			first, err := firstTime(ctx, tx, "replied_at", msg.ID)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE messages SET replied_at = coalesce(replied_at, $2) WHERE id = $1`, msg.ID, now); err != nil {
				return err
			}
			if first && msg.CampaignID != nil {
				_, err = tx.Exec(ctx, `UPDATE campaigns SET stat_replied = stat_replied + 1 WHERE id = $1`, *msg.CampaignID)
			}
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	s.bumpDaily(ctx, s.db.Pool, "replies", 1)
	ev := Event{ContactID: c.ID, Text: r.Subject + "\n" + body}
	if msg != nil {
		ev.CampaignID, ev.TemplateID, ev.MessageID = deref(msg.CampaignID), deref(msg.TemplateID), msg.ID
	}
	s.Fire(ctx, "reply_received", ev)
	return map[string]any{"id": id, "contact_id": c.ID}, nil
}

// LogReply is "Log a reply manually".
func (s *Service) LogReply(ctx context.Context, from, subject, text string) (map[string]any, error) {
	if !core.IsEmail(core.AddressOf(from)) {
		return nil, userErr("Enter the contact email")
	}
	r, err := s.RecordReply(ctx, IncomingReply{From: from, Subject: subject, Text: text})
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, userErr("No contact found with that email address")
	}
	return r, nil
}

var (
	unsubTokenRe = regexp.MustCompile(`(?i)^\s*unsubscribe\s+([a-f0-9]{24})\b`)
	unsubOnlyRe  = regexp.MustCompile(`(?i)^\s*unsubscribe\s*$`)
	bounceRe1    = regexp.MustCompile(`(?i)Final-Recipient:\s*rfc822;\s*([^\s]+)`)
	bounceRe2    = regexp.MustCompile(`(?i)(?:wasn't delivered to|couldn't be delivered to|delivery to the following recipient failed[^:]*:)\s*<?([^\s>]+@[^\s>]+)>?`)
	daemonRe     = regexp.MustCompile(`(?i)mailer-daemon|postmaster`)
	addrRe       = regexp.MustCompile(`[^\s<>(),;"']+@[^\s<>(),;"']+`)
)

// handleUnsubscribeRequest: the List-Unsubscribe mailto ("unsubscribe <token>") or a bare
// "unsubscribe" subject.
func (s *Service) handleUnsubscribeRequest(ctx context.Context, subject, fromEmail string) (bool, error) {
	if m := unsubTokenRe.FindStringSubmatch(subject); m != nil {
		_, err := s.Unsubscribe(ctx, strings.ToLower(m[1]))
		return true, err
	}
	if unsubOnlyRe.MatchString(subject) {
		_, err := s.UnsubscribeContact(ctx, core.EmailKey(fromEmail), nil)
		return true, err
	}
	return false, nil
}

// handleBounce marks the bounced recipient of a delivery failure report.
func (s *Service) handleBounce(ctx context.Context, text string) (bool, error) {
	m := bounceRe1.FindStringSubmatch(text)
	if m == nil {
		m = bounceRe2.FindStringSubmatch(text)
	}
	if m == nil {
		return false, nil
	}
	key := core.EmailKey(m[1])
	tag, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET status = 'bounced', bounced_at = $2 WHERE id = $1 AND status <> 'bounced'`, key, s.now())
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	s.stopRunsFor(ctx, key)
	s.Fire(ctx, "bounced", Event{ContactID: key})
	return true, nil
}

// recipientsOf lists every address a message was sent to (To, Cc, forwarding headers).
func recipientsOf(m *gmail.Message) []string {
	raw := strings.Join([]string{m.Header("To"), m.Header("Cc"), m.Header("Delivered-To"), m.Header("X-Original-To"), m.Header("X-Forwarded-To")}, ",")
	out := []string{}
	for _, a := range addrRe.FindAllString(raw, -1) {
		a = strings.ToLower(a)
		if !contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

// pollInbox reads recent inbox mail: bounces, unsubscribe requests, replies from contacts,
// auto-reply rules and the email_received trigger. Each Gmail message is handled once (the
// inbound table) (Replies.poll).
func (s *Service) pollInbox(ctx context.Context, hasTime func() bool) (int, error) {
	mb, account, err := s.mailbox(ctx)
	if err != nil {
		return 0, err
	}
	status := s.doc(ctx, "status")
	last, _ := strconv.ParseInt(str(status["last_poll_ms"]), 10, 64)
	if last == 0 {
		last = s.now().Add(-48 * time.Hour).UnixMilli()
	}
	started := s.now()
	since := (last - 10*60*1000) / 1000 // overlap; duplicates are ignored
	mine, _ := s.allowedSenders(ctx, account)
	refs, err := mb.List(ctx, "in:inbox after:"+strconv.FormatInt(since, 10), 200)
	if err != nil {
		return 0, err
	}
	seen := map[string]string{}
	found := 0
	// Oldest first, so replies and rules see mail in the order it came.
	for i := len(refs) - 1; i >= 0 && hasTime(); i-- {
		ref := refs[i]
		done, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM inbound WHERE id = $1`, "g-"+ref.ID)
		if err != nil {
			return found, err
		}
		if done > 0 {
			continue
		}
		msg, err := mb.Get(ctx, ref.ID)
		if err != nil {
			s.log.Warn("gmail message", "id", ref.ID, "err", err)
			continue
		}
		if n, err := s.handleInbound(ctx, msg, mine, seen); err != nil {
			s.log.Error("inbound message", "id", ref.ID, "err", err)
		} else {
			found += n
		}
	}
	s.noteStatus(ctx, map[string]any{"last_poll_ms": strconv.FormatInt(started.UnixMilli(), 10), "last_reply_poll": s.now().Format(time.RFC3339)})
	s.noteMailboxes(ctx, seen)
	return found, nil
}

func (s *Service) handleInbound(ctx context.Context, msg *gmail.Message, mine []string, seen map[string]string) (int, error) {
	from := msg.Header("From")
	fromEmail := core.AddressOf(from)
	if contains(mine, fromEmail) {
		return 0, nil
	}
	text := msg.Text
	if strings.TrimSpace(text) == "" && msg.HTML != "" {
		text = core.HTMLToText(msg.HTML)
	}
	if daemonRe.MatchString(fromEmail) {
		_, err := s.handleBounce(ctx, text)
		return 0, err
	}
	subject := msg.Header("Subject")
	if ok, err := s.handleUnsubscribeRequest(ctx, subject, fromEmail); ok || err != nil {
		return 0, err
	}
	recipients := recipientsOf(msg)
	tag, err := s.db.Pool.Exec(ctx, `INSERT INTO inbound (id, "from", from_email, "to", subject, snippet, received_at, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'received') ON CONFLICT (id) DO NOTHING`,
		"g-"+msg.ID, from, fromEmail, recipients, subject, core.Truncate(text, 300), msg.Date)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, nil // handled in an earlier poll
	}
	for _, a := range recipients {
		if contains(mine, a) {
			seen[a] = msg.Date.Format(time.RFC3339)
		}
	}
	found := 0
	if r, err := s.RecordReply(ctx, IncomingReply{ID: msg.ID, ThreadID: msg.ThreadID, From: from, Subject: subject, Text: text, Date: msg.Date}); err != nil {
		return 0, err
	} else if r != nil {
		found = 1
	}
	in := inboundMail{ID: msg.ID, ThreadID: msg.ThreadID, RFCMessageID: msg.Header("Message-ID"), From: from, FromEmail: fromEmail,
		Subject: subject, Text: core.StripQuoted(text), Date: msg.Date, Recipients: recipients, Header: msg.Header}
	res := s.autoReply(ctx, in, mine)
	var contactID *string
	if c, err := s.contact(ctx, s.db.Pool, core.EmailKey(fromEmail)); err == nil {
		contactID = &c.ID
		s.Fire(ctx, "email_received", Event{ContactID: c.ID, Text: subject + "\n" + in.Text, Subject: subject,
			GmailThreadID: msg.ThreadID, RFCMessageID: in.RFCMessageID, To: strings.Join(recipients, ",")})
	}
	var repliedAt *time.Time
	if res.Status == "replied" {
		now := s.now()
		repliedAt = &now
	}
	_, err = s.db.Pool.Exec(ctx, `UPDATE inbound SET status = $2, reason = $3, autoreply_rule = $4, replied_at = $5, contact_id = $6 WHERE id = $1`,
		"g-"+msg.ID, res.Status, nilIfEmpty(res.Reason), nilIfEmpty(res.Rule), repliedAt, contactID)
	return found, err
}

// noteMailboxes remembers when mail last arrived for each of our addresses (Settings shows it).
func (s *Service) noteMailboxes(ctx context.Context, seen map[string]string) {
	if len(seen) == 0 {
		return
	}
	doc := s.doc(ctx, "inbox")
	list := []any{}
	if prev, ok := doc["addresses"].([]any); ok {
		for _, x := range prev {
			if m, ok := x.(map[string]any); ok {
				if _, again := seen[str(m["email"])]; !again {
					list = append(list, m)
				}
			}
		}
	}
	for e, at := range seen {
		list = append(list, map[string]any{"email": e, "last_received_at": at})
	}
	if err := s.mergeDoc(ctx, s.db.Pool, "inbox", map[string]any{"addresses": list, "updated_at": s.now().Format(time.RFC3339)}); err != nil {
		s.log.Warn("inbox note", "err", err)
	}
}
