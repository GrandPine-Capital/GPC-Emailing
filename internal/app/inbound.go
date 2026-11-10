package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Inbound webhooks: POST <PUBLIC_BASE_URL>/hook?k=<webhook secret>[&src=chatdaddy][&event=name]
// (Inbound.js).
//   - ChatDaddy "message-insert": incoming WhatsApp messages become replies on the contact's
//     timeline and fire whatsapp_received.
//   - Anything else (forms, Zapier, Make, CRMs): JSON such as {"email", "phone", "first_name",
//     "company", "tags", "list_id", "event", "text"}; the contact is created or updated and
//     webhook_received fires.

// InboundContact is contact data from a webhook or an auto-reply rule.
type InboundContact struct {
	Email, Phone, Name, FirstName, LastName, Company, Website, Country, Industry, Source, ListID string
	Tags                                                                                         []string
}

// ErrBadWebhookKey: the webhook key is missing or wrong.
var ErrBadWebhookKey = errors.New("invalid webhook key")

// UpsertInboundContact creates the contact, or fills its empty fields and adds tags and the
// list; it fires contact_added and tag_added for what is new.
func (s *Service) UpsertInboundContact(ctx context.Context, d InboundContact) (*Contact, error) {
	cc := s.Settings(ctx).DefaultCountryCode
	email := ""
	if core.IsEmail(d.Email) {
		email = core.EmailKey(d.Email)
	}
	phone := core.PhoneKey(d.Phone, cc)
	var c *Contact
	var err error
	if email != "" {
		c, err = s.contact(ctx, s.db.Pool, email)
		if err != nil && !IsNotFound(err) {
			return nil, err
		}
	}
	if c == nil && phone != "" {
		if found, err := store.Struct[Contact](ctx, s.db.Pool, `SELECT * FROM contacts WHERE phone_key = $1 ORDER BY created_at LIMIT 1`, phone); err == nil {
			c = &found
		} else if !IsNotFound(err) {
			return nil, err
		}
	}
	first, last := d.FirstName, d.LastName
	if first == "" && d.Name != "" {
		parts := strings.Fields(d.Name)
		if len(parts) > 0 {
			first = parts[0]
			if last == "" {
				last = strings.Join(parts[1:], " ")
			}
		}
	}
	phoneField := d.Phone
	if phoneField == "" && phone != "" {
		phoneField = "+" + phone
	}
	fields := map[string]string{"first_name": first, "last_name": last, "company": d.Company, "website": d.Website,
		"country": d.Country, "industry": d.Industry, "phone": phoneField}
	tags := core.NormaliseTags(d.Tags)

	if c == nil {
		if email == "" && phone == "" {
			return nil, userErr("payload needs an email or phone")
		}
		id := email
		if id == "" {
			id = "wa-" + phone
		}
		source := d.Source
		if source == "" {
			source = "webhook"
		}
		lists := []string{}
		if d.ListID != "" {
			lists = append(lists, d.ListID)
		}
		nc := Contact{ID: id, Email: email, Tags: tags, ListIDs: lists, Status: "subscribed", Source: source, PhoneKey: phone}
		nc.FirstName, nc.LastName, nc.Company = strings.TrimSpace(fields["first_name"]), strings.TrimSpace(fields["last_name"]), strings.TrimSpace(fields["company"])
		nc.Website, nc.Country, nc.Industry, nc.Phone = strings.TrimSpace(fields["website"]), strings.TrimSpace(fields["country"]), strings.TrimSpace(fields["industry"]), strings.TrimSpace(fields["phone"])
		_, err := s.db.Pool.Exec(ctx, `INSERT INTO contacts (id, email, first_name, last_name, company, website, phone, phone_key, country, industry, tags, list_ids, status, source, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'subscribed',$13,$14)`,
			nc.ID, nc.Email, nc.FirstName, nc.LastName, nc.Company, nc.Website, nc.Phone, nc.PhoneKey, nc.Country, nc.Industry, nc.Tags, nc.ListIDs, nc.Source, s.now())
		if err != nil {
			return nil, store.MapErr(err)
		}
		if d.ListID != "" {
			s.Fire(ctx, "contact_added", Event{ContactID: id, ListID: d.ListID})
		}
		for _, t := range tags {
			s.Fire(ctx, "tag_added", Event{ContactID: id, Tag: t})
		}
		return &nc, nil
	}

	newTags := []string{}
	for _, t := range tags {
		if !c.HasTag(t) {
			newTags = append(newTags, t)
		}
	}
	newList := d.ListID != "" && !contains(c.ListIDs, d.ListID)
	err = s.db.InTx(ctx, func(tx pgx.Tx) error {
		for _, f := range core.ContactFields {
			v := strings.TrimSpace(fields[f])
			if v == "" {
				continue
			}
			// f is a fixed column name; only empty fields are filled.
			if _, err := tx.Exec(ctx, `UPDATE contacts SET `+f+` = $2 WHERE id = $1 AND `+f+` = ''`, c.ID, v); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE contacts SET email = CASE WHEN email = '' THEN $2 ELSE email END,
			phone_key = CASE WHEN phone_key = '' THEN $3 ELSE phone_key END,
			tags = tags || $4::text[], list_ids = CASE WHEN $5 <> '' AND NOT ($5 = ANY(list_ids)) THEN array_append(list_ids, $5) ELSE list_ids END
			WHERE id = $1`, c.ID, email, phone, newTags, d.ListID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, store.MapErr(err)
	}
	if newList {
		s.Fire(ctx, "contact_added", Event{ContactID: c.ID, ListID: d.ListID})
	}
	for _, t := range newTags {
		s.Fire(ctx, "tag_added", Event{ContactID: c.ID, Tag: t})
	}
	return s.contact(ctx, s.db.Pool, c.ID)
}

var nonIDRe = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// receiveWhatsApp records an incoming WhatsApp message and fires whatsapp_received.
func (s *Service) receiveWhatsApp(ctx context.Context, c *Contact, phone, text, externalID string) (bool, error) {
	id := "wa-" + core.Truncate(nonIDRe.ReplaceAllString(externalID, ""), 80)
	if externalID == "" {
		id = "wa-" + randomHex(10)
	}
	tag, err := s.db.Pool.Exec(ctx, `INSERT INTO replies (id, channel, contact_id, from_email, phone, first_name, last_name, company, subject, body, received_at, created_at)
		VALUES ($1,'whatsapp',$2,$3,$4,$5,$6,$7,'WhatsApp message',$8,$9,$9) ON CONFLICT (id) DO NOTHING`,
		id, c.ID, c.Email, phone, c.FirstName, c.LastName, c.Company, core.Truncate(text, 20000), s.now())
	if err != nil || tag.RowsAffected() == 0 {
		return false, err // a duplicate delivery is not an error
	}
	s.logWhatsApp(ctx, c, "in", text, "")
	if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET replied_at = $2 WHERE id = $1`, c.ID, s.now()); err != nil {
		return false, err
	}
	s.bumpDaily(ctx, s.db.Pool, "replies", 1)
	s.Fire(ctx, "whatsapp_received", Event{ContactID: c.ID, Text: text})
	return true, nil
}

var groupChatRe = regexp.MustCompile(`@g\.us$`)

// HandleWebhook handles POST /hook. params are the query parameters (and form fields), raw the
// request body.
func (s *Service) HandleWebhook(ctx context.Context, params map[string]string, raw []byte) (map[string]any, error) {
	secret, err := s.WebhookSecret(ctx)
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(params["k"]), []byte(secret)) != 1 {
		return nil, ErrBadWebhookKey
	}
	body := map[string]any{}
	if len(raw) > 0 && json.Unmarshal(raw, &body) != nil {
		body = map[string]any{}
		for k, v := range params {
			body[k] = v
		}
	} else if len(raw) == 0 {
		for k, v := range params {
			if k != "k" && k != "src" {
				body[k] = v
			}
		}
	}
	if params["src"] == "chatdaddy" || str(body["event"]) == "message-insert" {
		var items []any
		switch d := body["data"].(type) {
		case []any:
			items = d
		case map[string]any:
			items = []any{d}
		}
		cc := s.Settings(ctx).DefaultCountryCode
		handled := 0
		for _, it := range items {
			m, _ := it.(map[string]any)
			if m == nil || truthy(m["fromMe"]) {
				continue
			}
			chatID := str(m["chatId"])
			if groupChatRe.MatchString(chatID) {
				continue
			}
			phone := core.PhoneKey(chatID, cc)
			if phone == "" {
				continue
			}
			name := ""
			if sender, ok := m["sender"].(map[string]any); ok {
				name = str(sender["name"])
				if name == "" {
					name = str(sender["pushName"])
				}
			}
			c, err := s.UpsertInboundContact(ctx, InboundContact{Phone: "+" + phone, Name: name, Source: "whatsapp"})
			if err != nil {
				return nil, err
			}
			text := str(m["text"])
			if text == "" {
				text = "[attachment]"
			}
			if _, err := s.receiveWhatsApp(ctx, c, phone, text, str(m["id"])); err != nil {
				return nil, err
			}
			handled++
		}
		return map[string]any{"ok": true, "handled": handled}, nil
	}

	var tags []string
	switch t := body["tags"].(type) {
	case []any:
		for _, v := range t {
			tags = append(tags, str(v))
		}
	case string:
		tags = core.SplitTags(t)
	}
	c, err := s.UpsertInboundContact(ctx, InboundContact{
		Email: str(body["email"]), Phone: str(body["phone"]), Name: str(body["name"]), FirstName: str(body["first_name"]),
		LastName: str(body["last_name"]), Company: str(body["company"]), Website: str(body["website"]), Country: str(body["country"]),
		Industry: str(body["industry"]), Source: str(body["source"]), ListID: str(body["list_id"]), Tags: tags,
	})
	if err != nil {
		return nil, err
	}
	event := str(body["event"])
	if event == "" {
		event = params["event"]
	}
	text := str(body["text"])
	if text == "" {
		b, _ := json.Marshal(body)
		text = core.Truncate(string(b), 2000)
	}
	s.Fire(ctx, "webhook_received", Event{ContactID: c.ID, Event: event, Text: text})
	return map[string]any{"ok": true, "contact": c.ID}, nil
}
