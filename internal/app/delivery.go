package app

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Built is an e-mail personalised for one recipient.
type Built struct {
	Subject, HTML, Text string
	Headers             map[string]string
	UnsubscribeURL      string
}

type buildOpts struct {
	HTML, Subject string
	Vars          map[string]string // the recipient's fields
	Token         string
	Track         bool
	// NoUnsubscribe: transactional mail (auto-replies) carries no marketing footer.
	NoUnsubscribe bool
}

var (
	hrefRe    = regexp.MustCompile(`(?i)href\s*=\s*"(https?://[^"]+)"`)
	bodyEndRe = regexp.MustCompile(`(?i)</body>`)
	bodyRe    = regexp.MustCompile(`(?i)<body([^>]*)>`)
)

func beforeBodyEnd(body, insert string) string {
	if loc := bodyEndRe.FindStringIndex(body); loc != nil {
		return body[:loc[0]] + insert + body[loc[0]:]
	}
	return body + insert
}

// linkKey registers a URL for click tracking and returns its key.
func (s *Service) linkKey(ctx context.Context, url string) (string, error) {
	key := s.sign("link:" + url)
	_, err := s.db.Pool.Exec(ctx, `INSERT INTO links (key, url) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, key, url)
	return key, err
}

// buildEmail merges tags, adds the unsubscribe footer and headers, click-tracked links and the
// open pixel (Delivery.buildEmail).
func (s *Service) buildEmail(ctx context.Context, o buildOpts) (Built, error) {
	st := s.Settings(ctx)
	unsubscribeURL := s.baseURL + "/u?t=" + o.Token
	vars := core.ContactVars(o.Vars)
	vars["unsubscribe_url"] = unsubscribeURL
	vars["company_address"] = st.CompanyAddress
	vars["sender_name"] = st.FromName
	body := core.Merge(o.HTML, vars, true)

	if !o.NoUnsubscribe && !strings.Contains(body, unsubscribeURL) {
		addr := ""
		if st.CompanyAddress != "" {
			addr = core.EscapeHTML(st.CompanyAddress) + "<br>"
		}
		body = beforeBodyEnd(body, `<div style="font:12px/1.5 Arial,sans-serif;color:#6b7280;text-align:center;padding:16px;">`+addr+
			`<a href="`+unsubscribeURL+`" style="color:#6b7280;">Unsubscribe</a></div>`)
	}
	if o.Track {
		var ferr error
		body = hrefRe.ReplaceAllStringFunc(body, func(match string) string {
			raw := hrefRe.FindStringSubmatch(match)[1]
			url := strings.ReplaceAll(raw, "&amp;", "&")
			if url == unsubscribeURL {
				return match
			}
			key, err := s.linkKey(ctx, url)
			if err != nil {
				ferr = err
				return match
			}
			return `href="` + s.baseURL + "/r?t=" + o.Token + "&amp;k=" + key + `"`
		})
		if ferr != nil {
			return Built{}, ferr
		}
		body = beforeBodyEnd(body, `<img src="`+s.baseURL+"/o?t="+o.Token+`" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;">`)
	}
	headers := map[string]string{}
	if !o.NoUnsubscribe {
		list := []string{}
		// The mailto variant reaches the reply domain, where the worker reads it.
		if s.mailCfg.ReplyDomain != "" {
			list = append(list, "<mailto:unsubscribe@"+s.mailCfg.ReplyDomain+"?subject=unsubscribe%20"+o.Token+">")
		}
		list = append(list, "<"+s.baseURL+"/u1?t="+o.Token+">")
		headers["List-Unsubscribe"] = strings.Join(list, ", ")
		headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
	}
	text := core.HTMLToText(core.Merge(o.HTML, vars, false))
	if !o.NoUnsubscribe {
		text += "\n\nUnsubscribe: " + unsubscribeURL
	}
	return Built{Subject: core.Merge(o.Subject, vars, false), HTML: body, Text: text, Headers: headers, UnsubscribeURL: unsubscribeURL}, nil
}

func (s *Service) template(ctx context.Context, id string) (*Template, error) {
	t, err := store.Struct[Template](ctx, s.db.Pool, `SELECT id, name, mode, subject, html FROM templates WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// newMessage is a queued message row for one contact.
type newMessage struct {
	Contact                        *Contact
	TemplateID, Subject            string
	CampaignID, CampaignName       string
	AutomationID, RunID, FromEmail string
}

func (s *Service) insertMessage(ctx context.Context, q store.Q, m newMessage) (string, error) {
	token := ids.Token()
	_, err := q.Exec(ctx, `INSERT INTO messages (id, campaign_id, campaign_name, automation_id, automation_run_id, contact_id, email, name,
		company, template_id, from_email, subject, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',$13)`,
		token, nilIfEmpty(m.CampaignID), nilIfEmpty(m.CampaignName), nilIfEmpty(m.AutomationID), nilIfEmpty(m.RunID), m.Contact.ID,
		m.Contact.Email, m.Contact.Name(), m.Contact.Company, nilIfEmpty(m.TemplateID), nilIfEmpty(m.FromEmail), m.Subject, s.now())
	return token, store.MapErr(err)
}

// threadOpts make a send a reply to an earlier message (In-Reply-To), so mail clients thread it.
type threadOpts struct{ InReplyTo string }

// deliver renders and sends one queued message. It never fails the caller: it returns the
// message's new status, and the error when it failed (Delivery.deliver).
func (s *Service) deliver(ctx context.Context, msgID string, th threadOpts) (string, error) {
	m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE id = $1`, msgID)
	if err != nil {
		return "failed", err
	}
	var camp *Campaign
	if m.CampaignID != nil {
		if c, err := store.Struct[Campaign](ctx, s.db.Pool, `SELECT * FROM campaigns WHERE id = $1`, *m.CampaignID); err == nil {
			camp = &c
		}
	}
	finish := func(status string, set string, args []any, stat string) (string, error) {
		q := `UPDATE messages SET status = $2` + set + ` WHERE id = $1`
		if _, err := s.db.Pool.Exec(ctx, q, append([]any{m.ID, status}, args...)...); err != nil {
			return status, err
		}
		if camp != nil {
			if _, err := s.db.Pool.Exec(ctx, `UPDATE campaigns SET stat_queued = stat_queued - 1, stat_`+stat+` = stat_`+stat+` + 1 WHERE id = $1`, camp.ID); err != nil {
				return status, err
			}
		}
		return status, nil
	}
	fail := func(status, stat string, cause error) (string, error) {
		_, err := finish(status, ", error = $3", []any{core.Truncate(cause.Error(), 500)}, stat)
		if err != nil {
			return status, err
		}
		return status, cause
	}

	c, err := s.contact(ctx, s.db.Pool, m.ContactID)
	if IsNotFound(err) {
		return fail("skipped", "skipped", fmt.Errorf("contact missing"))
	} else if err != nil {
		return "failed", err
	}
	if c.Status != "subscribed" {
		return fail("skipped", "skipped", fmt.Errorf("contact %s", c.Status))
	}
	t, err := s.template(ctx, deref(m.TemplateID))
	if err != nil {
		return fail("failed", "failed", fmt.Errorf("template missing"))
	}
	html := t.HTML
	subject := m.Subject
	from, fromName, replyTo := deref(m.FromEmail), "", ""
	if camp != nil {
		if camp.Preheader != "" {
			html = bodyRe.ReplaceAllString(html, `<body$1><div style="display:none;max-height:0;overflow:hidden;">`+strings.ReplaceAll(core.EscapeHTML(camp.Preheader), "$", "$$")+`</div>`)
		}
		if subject == "" {
			subject = camp.Subject
		}
		if camp.FromEmail != "" {
			from = camp.FromEmail
		}
		fromName, replyTo = camp.FromName, camp.ReplyTo
	}
	if subject == "" {
		subject = t.Subject
	}
	email, err := s.buildEmail(ctx, buildOpts{HTML: html, Subject: subject, Vars: c.Fields(), Token: m.ID, Track: true})
	if err != nil {
		return fail("failed", "failed", err)
	}
	res, err := s.Send(ctx, Outgoing{
		To: c.Email, ToName: c.Name(), Subject: email.Subject, HTML: email.HTML, Text: email.Text,
		FromName: fromName, FromEmail: from, ReplyTo: replyTo, Headers: email.Headers, InReplyTo: th.InReplyTo,
	})
	if err != nil {
		return fail("failed", "failed", err)
	}
	if _, err := finish("sent", ", provider_id = $3, rfc_message_id = $4, subject = $5, sent_at = $6, error = NULL, dry_run = $7",
		[]any{res.ID, nilIfEmpty(res.RFCMessageID), email.Subject, s.now(), res.DryRun}, "sent"); err != nil {
		return "sent", err
	}
	s.bumpDaily(ctx, s.db.Pool, "sent", 1)
	s.Fire(ctx, "email_sent", Event{ContactID: c.ID, CampaignID: deref(m.CampaignID), TemplateID: deref(m.TemplateID), MessageID: m.ID, FromAutomation: deref(m.AutomationID)})
	return "sent", nil
}

// SendTest sends a template (with a campaign's sender settings when given) to one address,
// untracked (sendTest in Code.js).
func (s *Service) SendTest(ctx context.Context, email, templateID, campaignID string) (map[string]any, error) {
	if !core.IsEmail(email) {
		return nil, userErr("Enter a valid email address")
	}
	var camp *Campaign
	if campaignID != "" {
		c, err := store.Struct[Campaign](ctx, s.db.Pool, `SELECT * FROM campaigns WHERE id = $1`, campaignID)
		if err != nil {
			return nil, err
		}
		camp = &c
		if templateID == "" {
			templateID = deref(c.TemplateID)
		}
	}
	if templateID == "" {
		return nil, userErr("Choose a template first")
	}
	t, err := s.template(ctx, templateID)
	if IsNotFound(err) {
		return nil, userErr("Choose a template first")
	} else if err != nil {
		return nil, err
	}
	vars := map[string]string{}
	if c, err := s.contact(ctx, s.db.Pool, core.EmailKey(email)); err == nil {
		vars = c.Fields()
	} else {
		for k, v := range core.SampleContact {
			vars[k] = v
		}
		vars["email"] = email
	}
	subject := t.Subject
	if subject == "" {
		subject = t.Name
	}
	out := Outgoing{To: email, Force: true}
	if camp != nil {
		if camp.Subject != "" {
			subject = camp.Subject
		}
		out.FromName, out.FromEmail, out.ReplyTo = camp.FromName, camp.FromEmail, camp.ReplyTo
	}
	built, err := s.buildEmail(ctx, buildOpts{HTML: t.HTML, Subject: "[TEST] " + subject, Vars: vars, Token: "test"})
	if err != nil {
		return nil, err
	}
	out.Subject, out.HTML, out.Text = built.Subject, built.HTML, built.Text
	res, err := s.Send(ctx, out)
	if err != nil {
		return nil, userErr(err.Error())
	}
	return map[string]any{"ok": true, "dryRun": res.DryRun}, nil
}
