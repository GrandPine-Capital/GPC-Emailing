package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// The CRM (GPC-Lead, crm.grandpine.com) is the master of customer records and asks this service
// to send its notification e-mails. Two signed routes, both with header sig = lowercase hex
// HMAC-SHA256 of the raw body with the admin setting crm_hook_secret (Settings → Integrations):
//
//	POST /hooks/crm/contacts  quiet one-way bulk sync of people, their category and tags
//	POST /hooks/crm/events    a transactional e-mail the CRM asks for
//	POST /hooks/crm/ping      a connection test: changes nothing, answers {"ok":true}
//
// Every call that passes the signature check is noted (time and kind) in the "crm_hook" settings
// document, so Settings → Integrations can show when the CRM last got through.

// ErrCRMHookOff: crm_hook_secret is not set, so the CRM routes accept nothing.
var ErrCRMHookOff = errors.New("CRM hooks are not set up (Settings → Integrations → CRM (GPC-Lead) → Signing secret)")

const (
	crmMaxContacts  = 500
	crmMaxPrefix    = 20
	crmMaxVarLength = 5000
)

// The kinds of CRM call, as stored and shown.
const (
	CRMCallContacts = "contacts"
	CRMCallEvent    = "event"
	CRMCallPing     = "ping"
)

// crmVerify checks the signature against the stored secret and, when it passes, notes the call.
func (s *Service) crmVerify(ctx context.Context, sig string, body []byte, kind string) error {
	secret := s.Secrets(ctx)["crm_hook_secret"]
	if secret == "" {
		return ErrCRMHookOff
	}
	if !VerifySignature(secret, body, sig) {
		return ErrBadSignature
	}
	// A failed note never fails the request.
	if err := s.mergeDoc(ctx, s.db.Pool, "crm_hook", map[string]any{
		"last_call_at": time.Now().UTC().Format(time.RFC3339), "last_call_kind": kind,
	}); err != nil {
		s.log.WarnContext(ctx, "crm hook: last call not noted", "err", err)
	}
	return nil
}

// HandleCRMPing is the CRM's connection test: it proves the address and the signing secret match.
func (s *Service) HandleCRMPing(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if err := s.crmVerify(ctx, sig, body, CRMCallPing); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "service": "gpc-emailing"}, nil
}

type crmContact struct {
	Email      string          `json:"email"`
	ExternalID json.RawMessage `json:"externalId"` // the CRM's id; not stored here
	Name       string          `json:"name"`
	Phone      string          `json:"phone"`
	Tags       []string        `json:"tags"`
	Subscribed *bool           `json:"subscribed"`
	Remove     bool            `json:"remove"`
}

type crmInvalid struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// HandleCRMContacts applies the CRM's contact sync. It is quiet: it starts no automation (no
// contact_added or tag_added), sends nothing and calls no messaging service.
func (s *Service) HandleCRMContacts(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if err := s.crmVerify(ctx, sig, body, CRMCallContacts); err != nil {
		return nil, err
	}
	var in struct {
		TagPrefix string       `json:"tagPrefix"`
		Contacts  []crmContact `json:"contacts"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, userErr("not a contact sync")
	}
	if n := utf8.RuneCountInString(in.TagPrefix); n < 1 || n > crmMaxPrefix {
		return nil, userErr("tagPrefix is required (1 to 20 characters)")
	}
	if len(in.Contacts) > crmMaxContacts {
		return nil, userErr("at most 500 contacts per call")
	}
	prefix := in.TagPrefix
	invalid := []crmInvalid{}
	bad := func(i int, why string) { invalid = append(invalid, crmInvalid{i, why}) }

	type item struct {
		i    int
		key  string
		c    crmContact
		tags []string // the request's tags, normalised
	}
	var items []item
	seen := map[string]bool{}
	keys := []string{}
itemLoop:
	for i, c := range in.Contacts {
		if !core.IsEmail(c.Email) {
			bad(i, "invalid e-mail address")
			continue
		}
		key := core.EmailKey(c.Email)
		if seen[key] {
			bad(i, "address appears twice in this call")
			continue
		}
		tags := core.NormaliseTags(c.Tags)
		if !c.Remove {
			for _, t := range tags {
				if !strings.HasPrefix(t, prefix) {
					bad(i, "tag without the tagPrefix")
					continue itemLoop
				}
			}
		}
		seen[key] = true
		keys = append(keys, key)
		items = append(items, item{i, key, c, tags})
	}

	existing := map[string]Contact{}
	if len(keys) > 0 {
		rows, err := store.Structs[Contact](ctx, s.db.Pool, `SELECT * FROM contacts WHERE id = ANY($1)`, keys)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			existing[r.ID] = r
		}
	}
	cc := s.Settings(ctx).DefaultCountryCode
	created, updated, unchanged := 0, 0, 0
	batch := &pgx.Batch{}
	now := s.now()
	for _, it := range items {
		old, found := existing[it.key]
		name := strings.Fields(it.c.Name)
		first, last := "", ""
		if len(name) > 0 {
			first, last = name[0], strings.Join(name[1:], " ")
		}
		phone := strings.TrimSpace(it.c.Phone)
		if !found {
			if it.c.Remove {
				unchanged++
				continue
			}
			status := "subscribed"
			if it.c.Subscribed != nil && !*it.c.Subscribed {
				status = "unsubscribed"
			}
			var unsubAt any
			if status == "unsubscribed" {
				unsubAt = now
			}
			batch.Queue(`INSERT INTO contacts (id, email, first_name, last_name, phone, phone_key, tags, list_ids, status, source, created_at, unsubscribed_at)
				VALUES ($1,$1,$2,$3,$4,$5,$6,'{}',$7,'crm',$8,$9) ON CONFLICT (id) DO NOTHING`,
				it.key, first, last, phone, core.PhoneKey(phone, cc), it.tags, status, now, unsubAt)
			created++
			continue
		}
		// Present: the CRM is master of name, phone and the prefixed tags; nothing else is touched,
		// in particular never the status or the lists.
		kept := []string{}
		for _, t := range old.Tags {
			if !strings.HasPrefix(t, prefix) {
				kept = append(kept, t)
			}
		}
		want := kept
		if !it.c.Remove {
			want = append(append([]string{}, kept...), it.tags...)
		}
		want = core.NormaliseTags(want)
		cur := core.NormaliseTags(old.Tags)
		newFirst, newLast, newPhone := old.FirstName, old.LastName, old.Phone
		if first != "" {
			newFirst, newLast = first, last
		}
		if phone != "" {
			newPhone = phone
		}
		if it.c.Remove {
			newFirst, newLast, newPhone = old.FirstName, old.LastName, old.Phone
		}
		sameTags := len(want) == len(cur) && slices.Equal(sortedCopy(want), sortedCopy(cur))
		if sameTags && newFirst == old.FirstName && newLast == old.LastName && newPhone == old.Phone {
			unchanged++
			continue
		}
		batch.Queue(`UPDATE contacts SET first_name = $2, last_name = $3, phone = $4, phone_key = $5, tags = $6 WHERE id = $1`,
			it.key, newFirst, newLast, newPhone, core.PhoneKey(newPhone, cc), want)
		updated++
	}
	if batch.Len() > 0 {
		if err := s.db.InTx(ctx, func(tx pgx.Tx) error { return tx.SendBatch(ctx, batch).Close() }); err != nil {
			return nil, store.MapErr(err)
		}
	}
	return map[string]any{"ok": true, "created": created, "updated": updated, "unchanged": unchanged, "invalid": invalid}, nil
}

func sortedCopy(a []string) []string {
	b := append([]string{}, a...)
	slices.Sort(b)
	return b
}

// crmEventVars are the only variables an event may carry into its template.
var crmEventVars = []string{"product", "amount", "currency", "reference", "subject", "body"}

// HandleCRMEvent queues (and tries at once to send) the transactional e-mail the CRM asks for.
// The key makes it once-only: the same key again answers created:false.
func (s *Service) HandleCRMEvent(ctx context.Context, sig string, body []byte) (map[string]any, error) {
	if err := s.crmVerify(ctx, sig, body, CRMCallEvent); err != nil {
		return nil, err
	}
	var ev struct {
		Type string `json:"type"`
		Key  string `json:"key"`
		To   struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"to"`
		Vars map[string]any `json:"vars"`
	}
	if err := json.Unmarshal(body, &ev); err != nil || ev.Type == "" || strings.TrimSpace(ev.Key) == "" || len(ev.Key) > 180 {
		return nil, userErr("not a CRM event (type and key are required)")
	}
	te, ok := txnEvent(ev.Type)
	if !ok || te.Source != "crm" {
		return map[string]any{"ok": true, "ignored": "no e-mail for " + ev.Type}, nil
	}
	set := s.txnSettings(ctx).Events[ev.Type]
	if set.Off {
		return map[string]any{"ok": true, "ignored": te.Label + " is turned off (Settings → Transactional e-mails)"}, nil
	}
	if !core.IsEmail(ev.To.Email) {
		return map[string]any{"ok": true, "ignored": "no e-mail address"}, nil
	}
	vars := map[string]string{}
	for _, k := range crmEventVars {
		var v string
		switch x := ev.Vars[k].(type) {
		case string:
			v = x
		case float64, json.Number:
			b, _ := json.Marshal(x)
			v = string(b)
		}
		vars[k] = core.Truncate(strings.TrimSpace(v), crmMaxVarLength)
	}
	if ev.Type == "crm.owner_alert" {
		if vars["subject"] == "" || vars["body"] == "" {
			return nil, userErr("an owner alert needs vars.subject and vars.body")
		}
		// A header: one line.
		vars["subject"] = strings.Join(strings.Fields(vars["subject"]), " ")
	}
	reference := vars["reference"]
	if reference == "" {
		reference = ev.Key
	}
	id, created, err := s.QueueTransactional(ctx, TxnRequest{
		Source: "crm", Key: ev.Key, Template: te.DefaultKey, TemplateID: set.TemplateID,
		To: ev.To.Email, ToName: ev.To.Name, Reference: reference, Vars: vars,
	})
	if err != nil {
		return nil, err
	}
	status, err := s.SendTransactional(ctx, id)
	if err != nil {
		// Recorded and queued: the worker retries. The CRM need not.
		s.log.Warn("CRM e-mail not sent yet", "id", id, "type", ev.Type, "err", err)
	}
	return map[string]any{"ok": true, "id": id, "created": created, "status": status}, nil
}
