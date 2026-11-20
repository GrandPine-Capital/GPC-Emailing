package app

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Opt-in: people subscribe through a form (forms.go) or a webhook. With double opt-in the
// contact is pending, and is not mailed, until they follow the link in a confirmation e-mail;
// the lists and tags they signed up for apply at that moment, so automations start for people
// who can actually be mailed.
//
// Opt-out: the unsubscribe page (with the reason they give), one-click unsubscribe, and the
// preference page, where a subscriber joins and leaves the public lists (tracking.go, and the
// pages in httpapi).

func isWebURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// SubscribeInput is one sign-up.
type SubscribeInput struct {
	Contact       InboundContact
	ListIDs, Tags []string
	FormID        string
	DoubleOptIn   bool
}

// SubscribeResult: Outcome is subscribed, pending (a confirmation e-mail is on its way) or
// ignored (the address bounced or complained before, and stays off the list).
type SubscribeResult struct {
	Outcome string
	Contact *Contact
}

// Subscribe records a sign-up. Someone already subscribed gets the lists and tags at once; a
// new, pending or unsubscribed contact is asked to confirm first when in.DoubleOptIn.
func (s *Service) Subscribe(ctx context.Context, in SubscribeInput) (SubscribeResult, error) {
	if !core.IsEmail(in.Contact.Email) {
		return SubscribeResult{}, userErr("Enter a valid email address")
	}
	id := core.EmailKey(in.Contact.Email)
	existing, err := s.contact(ctx, s.db.Pool, id)
	if err != nil && !IsNotFound(err) {
		return SubscribeResult{}, err
	}
	if IsNotFound(err) {
		existing = nil
	}
	if existing != nil && (existing.Status == "bounced" || existing.Status == "complained") {
		return SubscribeResult{Outcome: "ignored"}, nil
	}
	first, last := in.Contact.FirstName, in.Contact.LastName
	if first == "" && in.Contact.Name != "" {
		if parts := strings.Fields(in.Contact.Name); len(parts) > 0 {
			first = parts[0]
			if last == "" {
				last = strings.Join(parts[1:], " ")
			}
		}
	}
	source := in.Contact.Source
	if source == "" {
		source = "form"
	}
	ci := ContactInput{Email: id, FirstName: first, LastName: last, Company: in.Contact.Company, Website: in.Contact.Website,
		Phone: in.Contact.Phone, Country: in.Contact.Country, Industry: in.Contact.Industry, Source: source}
	lists, err := s.knownLists(ctx, in.ListIDs)
	if err != nil {
		return SubscribeResult{}, err
	}
	tags := core.NormaliseTags(in.Tags)
	done := func(outcome string) (SubscribeResult, error) {
		c, err := s.contact(ctx, s.db.Pool, id)
		if err != nil {
			return SubscribeResult{}, err
		}
		return SubscribeResult{Outcome: outcome, Contact: c}, nil
	}

	if existing == nil || existing.Status == "subscribed" {
		if existing == nil && in.DoubleOptIn {
			ci.Status = "pending"
			if _, err := s.UpsertContacts(ctx, []ContactInput{ci}, nil, nil, source, false); err != nil {
				return SubscribeResult{}, err
			}
			if err := s.setPending(ctx, id, nil, lists, tags, in.FormID); err != nil {
				return SubscribeResult{}, err
			}
			s.Wake()
			return done("pending")
		}
		if _, err := s.UpsertContacts(ctx, []ContactInput{ci}, lists, tags, source, false); err != nil {
			return SubscribeResult{}, err
		}
		if in.FormID != "" {
			s.Fire(ctx, "form_submitted", Event{ContactID: id, FormID: in.FormID})
		}
		return done("subscribed")
	}

	// Pending or unsubscribed: fill in what they gave, and keep what they asked for until they
	// are (back) on the list.
	if _, err := s.UpsertContacts(ctx, []ContactInput{ci}, nil, nil, source, false); err != nil {
		return SubscribeResult{}, err
	}
	if err := s.setPending(ctx, id, existing.PendingOptIn, lists, tags, in.FormID); err != nil {
		return SubscribeResult{}, err
	}
	if in.DoubleOptIn {
		s.Wake()
		return done("pending")
	}
	if _, err := s.activate(ctx, id); err != nil {
		return SubscribeResult{}, err
	}
	return done("subscribed")
}

// knownLists drops list ids that no longer exist.
func (s *Service) knownLists(ctx context.Context, listIDs []string) ([]string, error) {
	out := []string{}
	if len(listIDs) == 0 {
		return out, nil
	}
	rows, err := store.Structs[struct {
		ID string `db:"id"`
	}](ctx, s.db.Pool, `SELECT id FROM lists WHERE id = ANY($1)`, listIDs)
	if err != nil {
		return nil, err
	}
	for _, id := range listIDs {
		for _, r := range rows {
			if r.ID == id && !contains(out, id) {
				out = append(out, id)
			}
		}
	}
	return out, nil
}

// setPending marks the contact pending with what confirming will apply (merged with what an
// earlier sign-up left), and asks for a confirmation e-mail, at most one every ten minutes.
func (s *Service) setPending(ctx context.Context, id string, prior map[string]any, lists, tags []string, formID string) error {
	allLists := append(strList(prior["list_ids"]), lists...)
	p := map[string]any{"list_ids": core.NormaliseTags(allLists), "tags": core.NormaliseTags(append(strList(prior["tags"]), tags...)), "form_id": formID}
	if formID == "" {
		p["form_id"] = str(prior["form_id"])
	}
	_, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET status = 'pending', pending_optin = $2::jsonb,
		optin_requested_at = CASE WHEN optin_sent_at IS NULL OR optin_sent_at < $3::timestamptz - interval '10 minutes' THEN $3 ELSE optin_requested_at END
		WHERE id = $1`, id, jsonText(p), s.now())
	return err
}

// activate subscribes a pending (or returning) contact: the lists and tags they signed up for
// apply now, and subscription_confirmed fires. False when they were subscribed already.
func (s *Service) activate(ctx context.Context, id string) (bool, error) {
	var pend map[string]any
	changed := false
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		var status string
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT status, pending_optin FROM contacts WHERE id = $1 FOR UPDATE`, id).Scan(&status, &raw); err != nil {
			return mapNoRows(err)
		}
		if status == "subscribed" {
			return nil
		}
		if status == "bounced" || status == "complained" {
			return userErr("This address cannot be subscribed")
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &pend)
		}
		changed = true
		_, err := tx.Exec(ctx, `UPDATE contacts SET status = 'subscribed', confirmed_at = $2, pending_optin = NULL, unsubscribe_reason = '' WHERE id = $1`, id, s.now())
		return err
	})
	if err != nil || !changed {
		return false, err
	}
	if err := s.applyMembership(ctx, id, strList(pend["list_ids"]), strList(pend["tags"])); err != nil {
		return true, err
	}
	formID := str(pend["form_id"])
	s.Fire(ctx, "subscription_confirmed", Event{ContactID: id, FormID: formID})
	if formID != "" {
		s.Fire(ctx, "form_submitted", Event{ContactID: id, FormID: formID})
	}
	return true, nil
}

// applyMembership adds the contact to lists and tags, firing contact_added and tag_added.
func (s *Service) applyMembership(ctx context.Context, id string, lists, tags []string) error {
	lists, err := s.knownLists(ctx, lists)
	if err != nil {
		return err
	}
	for _, l := range lists {
		if _, err := s.AddToList(ctx, []string{id}, l); err != nil {
			return err
		}
	}
	for _, t := range core.NormaliseTags(tags) {
		if _, err := s.addTag(ctx, []string{id}, t); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- confirmation links

// optInToken is the confirmation link's token: the contact id and its signature.
func (s *Service) optInToken(contactID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(contactID)) + "." + s.sign("optin:"+contactID)
}

func (s *Service) contactOfOptInToken(token string) (string, bool) {
	enc, sig, ok := strings.Cut(token, ".")
	if !ok {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || len(raw) == 0 {
		return "", false
	}
	id := string(raw)
	if subtle.ConstantTimeCompare([]byte(sig), []byte(s.sign("optin:"+id))) != 1 {
		return "", false
	}
	return id, true
}

// OptInInfo is what the confirmation page shows: the address, and whether there is still
// something to confirm. ok is false for a link that is not ours or whose contact is gone.
func (s *Service) OptInInfo(ctx context.Context, token string) (email, status string, ok bool) {
	id, valid := s.contactOfOptInToken(token)
	if !valid {
		return "", "", false
	}
	c, err := s.contact(ctx, s.db.Pool, id)
	if err != nil {
		return "", "", false
	}
	return c.Email, c.Status, true
}

// Confirm completes a double opt-in. False when the link is not valid any more: the contact
// unsubscribed, bounced or was deleted since.
func (s *Service) Confirm(ctx context.Context, token string) (bool, error) {
	id, valid := s.contactOfOptInToken(token)
	if !valid {
		return false, nil
	}
	c, err := s.contact(ctx, s.db.Pool, id)
	if IsNotFound(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	switch c.Status {
	case "subscribed":
		return true, nil
	case "pending":
		_, err := s.activate(ctx, id)
		return err == nil, err
	}
	return false, nil
}

// OptInLanding is what a confirmed subscriber sees: a message, or a page to go on to.
func (s *Service) OptInLanding(ctx context.Context) (message, redirect string) {
	st := s.Settings(ctx)
	message = st.OptinConfirmedMessage
	if message == "" {
		message = "Thank you. Your subscription is confirmed."
	}
	return message, st.OptinRedirectURL
}

// UnsubscribeOptions: whether the unsubscribe page asks for a reason, and where it sends
// people afterwards ("" for the built-in confirmation).
func (s *Service) UnsubscribeOptions(ctx context.Context) (askReason bool, redirect string) {
	st := s.Settings(ctx)
	return st.AskUnsubscribeReason, st.UnsubscribeRedirectURL
}

// RequestOptIn queues a confirmation e-mail for the pending contacts among ids.
func (s *Service) RequestOptIn(ctx context.Context, ids []string) (int, error) {
	tag, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET optin_requested_at = $2 WHERE id = ANY($1) AND status = 'pending' AND email <> ''`, ids, s.now())
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() > 0 {
		s.Wake()
	}
	return int(tag.RowsAffected()), nil
}

const fallbackOptInHTML = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#374151;">
<p>Hi {{first_name|there}},</p><p>Please confirm that you would like to receive e-mails from {{sender_name}}.</p></body></html>`

// sendOptIn sends the confirmation e-mail: the template chosen in Settings, with
// {{confirm_url}}; a template without the tag gets a button added.
func (s *Service) sendOptIn(ctx context.Context, c *Contact) error {
	st := s.Settings(ctx)
	html, subject := fallbackOptInHTML, ""
	if t, err := s.template(ctx, st.OptinTemplateID); err == nil {
		html, subject = t.HTML, t.Subject
	} else if !IsNotFound(err) {
		return err
	}
	if st.OptinSubject != "" {
		subject = st.OptinSubject
	}
	if subject == "" {
		subject = "Please confirm your subscription"
	}
	confirmURL := s.baseURL + "/c?t=" + s.optInToken(c.ID)
	if !strings.Contains(html, "confirm_url") {
		html = beforeBodyEnd(html, `<p style="font-family:Arial,Helvetica,sans-serif;"><a href="{{confirm_url}}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:bold;">Confirm my subscription</a></p>`)
	}
	built, err := s.buildEmail(ctx, buildOpts{HTML: html, Subject: subject, Vars: c.Fields(), Token: "optin", NoUnsubscribe: true,
		Extra: map[string]string{"confirm_url": confirmURL}})
	if err != nil {
		return err
	}
	_, err = s.Send(ctx, Outgoing{To: c.Email, ToName: c.Name(), Subject: built.Subject, HTML: built.HTML, Text: built.Text})
	return err
}

// processOptIns sends the confirmation e-mails that are owed (the worker's first step, so a
// sign-up is answered within seconds).
func (s *Service) processOptIns(ctx context.Context, hasTime func() bool) (int, error) {
	due, err := store.Structs[Contact](ctx, s.db.Pool, `SELECT * FROM contacts WHERE status = 'pending' AND email <> ''
		AND optin_requested_at IS NOT NULL AND (optin_sent_at IS NULL OR optin_sent_at < optin_requested_at)
		ORDER BY optin_requested_at LIMIT 100`)
	if err != nil || len(due) == 0 {
		return 0, err
	}
	if err := s.canSend(ctx); err != nil {
		return 0, err
	}
	budget := s.RemainingToday(ctx)
	sent := 0
	for i := range due {
		if budget <= 0 || !hasTime() {
			break
		}
		if err := s.sendOptIn(ctx, &due[i]); err != nil {
			if errors.Is(err, ErrNoMailer) {
				return sent, err
			}
			s.log.Error("opt-in e-mail", "contact", due[i].ID, "err", err)
			continue
		}
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET optin_sent_at = $2 WHERE id = $1`, due[i].ID, s.now()); err != nil {
			return sent, err
		}
		s.bumpDaily(ctx, s.db.Pool, "sent", 1)
		budget--
		sent++
	}
	return sent, nil
}

// ---------------------------------------------------------------- preference page

// PrefList is a public list on the preference page.
type PrefList struct {
	ID          string `db:"id"`
	Name        string `db:"name"`
	Description string `db:"description"`
	Member      bool   `db:"member"`
}

// Preferences is what the preference page shows for the person an e-mail was sent to.
type Preferences struct {
	Email, FirstName, LastName, Status string
	Lists                              []PrefList
}

// Preferences reads the preference page for a message's token. ErrNotFound for a preview or
// expired link.
func (s *Service) Preferences(ctx context.Context, token string) (*Preferences, error) {
	m, err := s.messageByToken(ctx, token)
	if err != nil {
		return nil, err
	}
	c, err := s.contact(ctx, s.db.Pool, m.ContactID)
	if err != nil {
		return nil, err
	}
	lists, err := store.Structs[PrefList](ctx, s.db.Pool, `SELECT id, name, description, id = ANY($1::text[]) AS member FROM lists WHERE is_public ORDER BY lower(name)`, orEmptyList(c.ListIDs))
	if err != nil {
		return nil, err
	}
	return &Preferences{Email: c.Email, FirstName: c.FirstName, LastName: c.LastName, Status: c.Status, Lists: lists}, nil
}

// SavePreferences stores the person's name and which public lists they are on. Lists that are
// not public are left as they were.
func (s *Service) SavePreferences(ctx context.Context, token, first, last string, listIDs []string) error {
	p, err := s.Preferences(ctx, token)
	if err != nil {
		return err
	}
	m, err := s.messageByToken(ctx, token)
	if err != nil {
		return err
	}
	if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET first_name = $2, last_name = $3 WHERE id = $1`, m.ContactID,
		core.Truncate(strings.TrimSpace(first), 100), core.Truncate(strings.TrimSpace(last), 100)); err != nil {
		return err
	}
	for _, l := range p.Lists {
		want := contains(listIDs, l.ID)
		switch {
		case want && !l.Member:
			if _, err := s.AddToList(ctx, []string{m.ContactID}, l.ID); err != nil {
				return err
			}
		case !want && l.Member:
			if err := s.RemoveFromList(ctx, []string{m.ContactID}, l.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// ViewOnline renders a sent e-mail for its recipient ("View in browser"), without tracking.
// ErrNotFound when the message, its contact or its template is gone.
func (s *Service) ViewOnline(ctx context.Context, token string) (subject, html string, err error) {
	m, err := s.messageByToken(ctx, token)
	if err != nil {
		return "", "", err
	}
	c, err := s.contact(ctx, s.db.Pool, m.ContactID)
	if err != nil {
		return "", "", err
	}
	t, err := s.template(ctx, deref(m.TemplateID))
	if err != nil {
		return "", "", err
	}
	var camp *Campaign
	if m.CampaignID != nil {
		if cc, err := store.Struct[Campaign](ctx, s.db.Pool, `SELECT * FROM campaigns WHERE id = $1`, *m.CampaignID); err == nil {
			camp = &cc
		}
	}
	body, subj := messageContent(*m, t, camp)
	built, err := s.buildEmail(ctx, buildOpts{HTML: body, Subject: subj, Vars: c.Fields(), Token: m.ID})
	if err != nil {
		return "", "", err
	}
	return built.Subject, built.HTML, nil
}

// ---------------------------------------------------------------- tags

// Tags lists every tag in use with how many contacts carry it.
func (s *Service) Tags(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT t AS tag, count(*) AS contacts, count(*) FILTER (WHERE c.status = 'subscribed') AS subscribed
		FROM contacts c, unnest(c.tags) AS t GROUP BY t ORDER BY lower(t)`)
}

// addTag tags contacts and fires tag_added for those who did not carry it.
func (s *Service) addTag(ctx context.Context, contactIDs []string, tag string) (int, error) {
	rows, err := store.Structs[struct {
		ID string `db:"id"`
	}](ctx, s.db.Pool, `UPDATE contacts SET tags = array_append(tags, $2) WHERE id = ANY($1) AND NOT ($2 = ANY(tags)) RETURNING id`, contactIDs, tag)
	if err != nil {
		return 0, err
	}
	var tagged []pair
	for _, r := range rows {
		tagged = append(tagged, pair{r.ID, tag})
	}
	s.fireTagAdded(ctx, tagged)
	return len(rows), nil
}

// removeTag takes a tag off contacts (every contact when contactIDs is nil) and fires
// tag_removed for those who carried it.
func (s *Service) removeTag(ctx context.Context, contactIDs []string, tag string) (int, error) {
	rows, err := store.Structs[struct {
		ID string `db:"id"`
	}](ctx, s.db.Pool, `UPDATE contacts SET tags = array_remove(tags, $2) WHERE $2 = ANY(tags) AND ($1::text[] IS NULL OR id = ANY($1)) RETURNING id`, contactIDs, tag)
	if err != nil {
		return 0, err
	}
	var gone []pair
	for _, r := range rows {
		gone = append(gone, pair{r.ID, tag})
	}
	s.fireTagRemoved(ctx, gone)
	return len(rows), nil
}

// RenameTag renames a tag on every contact, form and campaign audience (merging into `to` where
// a contact has both). Automations that name the tag are not rewritten.
func (s *Service) RenameTag(ctx context.Context, from, to string) (int, error) {
	from, to = strings.TrimSpace(from), strings.TrimSpace(to)
	if from == "" || to == "" {
		return 0, userErr("Enter the new tag name")
	}
	if strings.ContainsAny(to, ",;|") {
		return 0, userErr("A tag cannot contain , ; or |")
	}
	if from == to {
		return 0, nil
	}
	n := 0
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE contacts SET tags = CASE WHEN $2 = ANY(tags) THEN array_remove(tags, $1) ELSE array_replace(tags, $1, $2) END
			WHERE $1 = ANY(tags)`, from, to)
		if err != nil {
			return err
		}
		n = int(tag.RowsAffected())
		// Fixed table and column names.
		for _, tc := range [][2]string{{"forms", "tags"}, {"campaigns", "tags"}, {"campaigns", "exclude_tags"}} {
			if _, err := tx.Exec(ctx, `UPDATE `+tc[0]+` SET `+tc[1]+` = CASE WHEN $2 = ANY(`+tc[1]+`) THEN array_remove(`+tc[1]+`, $1)
				ELSE array_replace(`+tc[1]+`, $1, $2) END WHERE $1 = ANY(`+tc[1]+`)`, from, to); err != nil {
				return err
			}
		}
		return nil
	})
	return n, err
}

// DeleteTag removes a tag from every contact.
func (s *Service) DeleteTag(ctx context.Context, tag string) (int, error) {
	if strings.TrimSpace(tag) == "" {
		return 0, userErr("Choose a tag")
	}
	return s.removeTag(ctx, nil, tag)
}
