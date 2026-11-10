package app

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/ses"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// IncomingReply is a reply to record (from the inbox, or logged by hand).
type IncomingReply struct {
	ID, From, Subject, Text string
	// References are the Message-IDs the reply names (In-Reply-To, References).
	References []string
	Date       time.Time
}

// RecordReply stores a reply, links it to the message it answers (by the Message-ID it names,
// else the contact's latest sent message) and fires reply_received. Nil when the sender is not
// a contact or the reply was already stored (Replies.record).
func (s *Service) RecordReply(ctx context.Context, r IncomingReply) (map[string]any, error) {
	fromEmail := core.AddressOf(r.From)
	if fromEmail == "" || s.ourAddress(ctx, fromEmail) {
		return nil, nil
	}
	var msg *Message
	if len(r.References) > 0 {
		if m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE rfc_message_id = ANY($1) ORDER BY sent_at DESC NULLS LAST LIMIT 1`, r.References); err == nil {
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

// markBounced marks a recipient bounced, stops their automations and fires bounced.
func (s *Service) markBounced(ctx context.Context, addr string) (bool, error) {
	key := core.EmailKey(addr)
	tag, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET status = 'bounced', bounced_at = $2 WHERE id = $1 AND status <> 'bounced'`, key, s.now())
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	s.stopRunsFor(ctx, key)
	s.Fire(ctx, "bounced", Event{ContactID: key})
	return true, nil
}

// handleBounce reads a delivery failure report that reached the reply domain.
func (s *Service) handleBounce(ctx context.Context, text string) (bool, error) {
	m := bounceRe1.FindStringSubmatch(text)
	if m == nil {
		m = bounceRe2.FindStringSubmatch(text)
	}
	if m == nil {
		return false, nil
	}
	return s.markBounced(ctx, m[1])
}

// processEvents reads SES bounce and complaint events: a permanent bounce marks the contact
// bounced; a complaint (marked as spam) unsubscribes them.
func (s *Service) processEvents(ctx context.Context, hasTime func() bool) (int, error) {
	if s.mail == nil {
		return 0, nil
	}
	total := 0
	for hasTime() {
		n, err := s.mail.PollEvents(ctx, func(ev ses.Event) error {
			var msg *Message
			if ev.MessageID != "" {
				if m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE provider_id = $1`, ev.MessageID); err == nil {
					msg = &m
				}
			}
			switch {
			case ev.Type == "Bounce" && ev.Permanent:
				s.noteTransactionalEvent(ctx, ev.MessageID, "bounced")
			case ev.Type == "Complaint":
				s.noteTransactionalEvent(ctx, ev.MessageID, "complained")
			}
			for _, r := range ev.Recipients {
				switch {
				case ev.Type == "Bounce" && ev.Permanent:
					if _, err := s.markBounced(ctx, r); err != nil {
						return err
					}
					if msg != nil {
						_, _ = s.db.Pool.Exec(ctx, `UPDATE messages SET error = 'bounced' WHERE id = $1`, msg.ID)
					}
				case ev.Type == "Complaint":
					if _, err := s.UnsubscribeContact(ctx, core.EmailKey(r), msg); err != nil {
						return err
					}
				}
			}
			return nil
		})
		total += n
		if err != nil || n == 0 {
			return total, err
		}
	}
	return total, nil
}

var addrRe = regexp.MustCompile(`[^\s<>(),;"']+@[^\s<>(),;"']+`)

// recipientsOf lists every address a message was sent to (To, Cc, forwarding headers), with
// reply-domain addresses mapped back to the sending addresses they stand for.
func (s *Service) recipientsOf(ctx context.Context, m *ses.Message) []string {
	raw := strings.Join([]string{m.Header("To"), m.Header("Cc"), m.Header("Delivered-To"), m.Header("X-Original-To"), m.Header("X-Forwarded-To")}, ",")
	out := []string{}
	for _, a := range addrRe.FindAllString(raw, -1) {
		a = s.mapReply(ctx, strings.ToLower(a))
		if !contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

var msgIDRe = regexp.MustCompile(`<[^<>\s]+>`)

// ForwardedHeader marks the copies the service forwards, so a mailbox that forwards them back
// to the reply domain cannot start a loop.
const ForwardedHeader = "X-GPC-Emailing-Forwarded"

// processInbound reads the mail SES received on the reply domain: bounces, unsubscribe
// requests, replies from contacts, auto-reply rules and the email_received trigger; each
// message is then forwarded to the mailbox it was meant for. Each is handled once (the
// inbound table).
func (s *Service) processInbound(ctx context.Context, hasTime func() bool) (int, error) {
	if s.mail == nil {
		return 0, nil
	}
	seen := map[string]string{}
	found := 0
	for hasTime() {
		n, err := s.mail.PollInbound(ctx, func(id string, raw []byte) error {
			m, err := ses.Parse(id, raw)
			if err != nil {
				s.log.Warn("inbound mail not readable", "id", id, "err", err)
				return nil
			}
			got, err := s.handleInbound(ctx, m, seen)
			found += got
			return err
		})
		if err != nil {
			return found, err
		}
		if n == 0 {
			break
		}
	}
	s.noteStatus(ctx, map[string]any{"last_reply_poll": s.now().Format(time.RFC3339)})
	s.noteMailboxes(ctx, seen)
	return found, nil
}

func (s *Service) handleInbound(ctx context.Context, msg *ses.Message, seen map[string]string) (int, error) {
	if msg.Header(ForwardedHeader) != "" {
		return 0, nil
	}
	from := msg.Header("From")
	fromEmail := core.AddressOf(from)
	if s.ourAddress(ctx, fromEmail) {
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
	recipients := s.recipientsOf(ctx, msg)
	tag, err := s.db.Pool.Exec(ctx, `INSERT INTO inbound (id, "from", from_email, "to", subject, snippet, received_at, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'received') ON CONFLICT (id) DO NOTHING`,
		"s-"+msg.ID, from, fromEmail, recipients, subject, core.Truncate(text, 300), msg.Date)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, nil // handled before (SQS delivers at least once)
	}
	for _, a := range recipients {
		if s.ourAddress(ctx, a) {
			seen[a] = msg.Date.Format(time.RFC3339)
		}
	}
	refs := msgIDRe.FindAllString(msg.Header("In-Reply-To")+" "+msg.Header("References"), -1)
	found := 0
	if r, err := s.RecordReply(ctx, IncomingReply{ID: msg.ID, From: from, Subject: subject, Text: text, References: refs, Date: msg.Date}); err != nil {
		return 0, err
	} else if r != nil {
		found = 1
	}
	in := inboundMail{ID: msg.ID, RFCMessageID: msg.Header("Message-ID"), From: from, FromEmail: fromEmail,
		Subject: subject, Text: core.StripQuoted(text), Date: msg.Date, Recipients: recipients, Header: msg.Header}
	res := s.autoReply(ctx, in)
	var contactID *string
	if c, err := s.contact(ctx, s.db.Pool, core.EmailKey(fromEmail)); err == nil {
		contactID = &c.ID
		s.Fire(ctx, "email_received", Event{ContactID: c.ID, Text: subject + "\n" + in.Text, Subject: subject,
			RFCMessageID: in.RFCMessageID, To: strings.Join(recipients, ",")})
	}
	var repliedAt *time.Time
	if res.Status == "replied" {
		now := s.now()
		repliedAt = &now
	}
	if _, err := s.db.Pool.Exec(ctx, `UPDATE inbound SET status = $2, reason = $3, autoreply_rule = $4, replied_at = $5, contact_id = $6 WHERE id = $1`,
		"s-"+msg.ID, res.Status, nilIfEmpty(res.Reason), nilIfEmpty(res.Rule), repliedAt, contactID); err != nil {
		return found, err
	}
	s.forward(ctx, msg, from, subject, text, recipients)
	return found, nil
}

// forward sends a copy of inbound mail to the real mailbox of each of our addresses it was
// sent to (sales@reply.grandpine.com → sales@grandpine.com), with the original attached and
// Reply-To the sender, so staff answer from their own mailbox.
func (s *Service) forward(ctx context.Context, msg *ses.Message, from, subject, text string, recipients []string) {
	for _, to := range recipients {
		if !s.senderAllowed(ctx, to) {
			continue
		}
		body := fmt.Sprintf("Reply received by GPC Emailing.\n\nFrom: %s\nTo: %s\nDate: %s\nSubject: %s\n\n%s",
			from, to, msg.Date.Format(time.RFC1123Z), subject, core.Truncate(text, 50000))
		if _, err := s.Send(ctx, Outgoing{
			To: to, FromEmail: to, FromName: "GPC Emailing", ReplyTo: core.AddressOf(from), Force: true,
			Subject: "Fwd: " + subject, Text: body, Attachment: msg.Raw,
			Headers: map[string]string{ForwardedHeader: "1", "Auto-Submitted": "auto-forwarded"},
		}); err != nil {
			s.log.Warn("forward reply", "to", to, "err", err)
		}
	}
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
