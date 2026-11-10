package app

import (
	"context"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Contacts and lists: the routes hosting/js/backend.js served from Firestore.

// hasActiveTrigger saves firing one event per contact on big imports when nothing listens.
func (s *Service) hasActiveTrigger(ctx context.Context, trigger string) bool {
	n, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM automations WHERE status = 'active' AND trigger_type = $1`, trigger)
	return err != nil || n > 0
}

type pair struct{ contact, value string }

func (s *Service) fireContactAdded(ctx context.Context, items []pair) {
	if len(items) == 0 || !s.hasActiveTrigger(ctx, "contact_added") {
		return
	}
	for _, it := range items {
		s.Fire(ctx, "contact_added", Event{ContactID: it.contact, ListID: it.value})
	}
}

func (s *Service) fireTagAdded(ctx context.Context, items []pair) {
	if len(items) == 0 || !s.hasActiveTrigger(ctx, "tag_added") {
		return
	}
	for _, it := range items {
		s.Fire(ctx, "tag_added", Event{ContactID: it.contact, Tag: it.value})
	}
}

// ContactInput is one contact to create or update.
type ContactInput struct {
	Email, FirstName, LastName, Company, Website, Phone, Country, Industry, Status, Source string
	Tags, ListIDs                                                                          []string
}

func (in ContactInput) field(f string) string {
	switch f {
	case "first_name":
		return in.FirstName
	case "last_name":
		return in.LastName
	case "company":
		return in.Company
	case "website":
		return in.Website
	case "phone":
		return in.Phone
	case "country":
		return in.Country
	case "industry":
		return in.Industry
	}
	return ""
}

func setField(c *Contact, f, v string) {
	switch f {
	case "first_name":
		c.FirstName = v
	case "last_name":
		c.LastName = v
	case "company":
		c.Company = v
	case "website":
		c.Website = v
	case "phone":
		c.Phone = v
	case "country":
		c.Country = v
	case "industry":
		c.Industry = v
	}
}

func getField(c *Contact, f string) string {
	switch f {
	case "first_name":
		return c.FirstName
	case "last_name":
		return c.LastName
	case "company":
		return c.Company
	case "website":
		return c.Website
	case "phone":
		return c.Phone
	case "country":
		return c.Country
	case "industry":
		return c.Industry
	}
	return ""
}

// UpsertResult counts an upsert.
type UpsertResult struct {
	Created int      `json:"created"`
	Updated int      `json:"updated"`
	IDs     []string `json:"ids"`
}

// UpsertContacts creates or updates contacts by e-mail. Existing non-empty fields are kept
// unless overwrite; tags and lists are merged (upsertContacts in backend.js).
func (s *Service) UpsertContacts(ctx context.Context, list []ContactInput, listIDs, tags []string, source string, overwrite bool) (UpsertResult, error) {
	res := UpsertResult{IDs: []string{}}
	keys := []string{}
	for _, c := range list {
		if core.IsEmail(c.Email) {
			keys = append(keys, core.EmailKey(c.Email))
		}
	}
	existing := map[string]*Contact{}
	rows, err := store.Structs[Contact](ctx, s.db.Pool, `SELECT * FROM contacts WHERE id = ANY($1)`, keys)
	if err != nil {
		return res, err
	}
	for i := range rows {
		existing[rows[i].ID] = &rows[i]
	}
	cc := s.Settings(ctx).DefaultCountryCode
	var added, tagged []pair
	batch := &pgx.Batch{}
	seen := map[string]bool{}
	base := s.now()
	for i, in := range list {
		if !core.IsEmail(in.Email) {
			continue
		}
		key := core.EmailKey(in.Email)
		if seen[key] {
			continue
		}
		seen[key] = true
		old := existing[key]
		var c Contact
		if old != nil {
			c = *old
		} else {
			src := in.Source
			if src == "" {
				src = source
			}
			c = Contact{ID: key, Email: key, Tags: []string{}, ListIDs: []string{}, Status: "subscribed", Source: src, CreatedAt: base.Add(-time.Duration(i) * time.Millisecond)}
		}
		for _, f := range core.ContactFields {
			v := strings.TrimSpace(in.field(f))
			if v != "" && (overwrite || getField(&c, f) == "") {
				setField(&c, f, v)
			}
		}
		if in.Status != "" && (overwrite || old == nil) {
			if in.Status != "subscribed" && in.Status != "unsubscribed" && in.Status != "bounced" {
				return res, userErr("Status must be subscribed, unsubscribed or bounced")
			}
			c.Status = in.Status
		}
		before := c.Tags
		c.Tags = core.NormaliseTags(append(append(append([]string{}, before...), in.Tags...), tags...))
		for _, t := range c.Tags {
			if !contains(before, t) {
				tagged = append(tagged, pair{key, t})
			}
		}
		for _, l := range append(append([]string{}, in.ListIDs...), listIDs...) {
			if l != "" && !contains(c.ListIDs, l) {
				c.ListIDs = append(c.ListIDs, l)
				added = append(added, pair{key, l})
			}
		}
		c.PhoneKey = core.PhoneKey(c.Phone, cc)
		batch.Queue(`INSERT INTO contacts (id, email, first_name, last_name, company, website, phone, phone_key, country, industry, tags, list_ids, status, source, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, company = EXCLUDED.company,
			  website = EXCLUDED.website, phone = EXCLUDED.phone, phone_key = EXCLUDED.phone_key, country = EXCLUDED.country,
			  industry = EXCLUDED.industry, tags = EXCLUDED.tags, list_ids = EXCLUDED.list_ids, status = EXCLUDED.status`,
			c.ID, c.Email, c.FirstName, c.LastName, c.Company, c.Website, c.Phone, c.PhoneKey, c.Country, c.Industry, c.Tags, c.ListIDs, c.Status, c.Source, c.CreatedAt)
		if old != nil {
			res.Updated++
		} else {
			res.Created++
		}
		res.IDs = append(res.IDs, key)
	}
	if batch.Len() > 0 {
		if err := s.db.InTx(ctx, func(tx pgx.Tx) error { return tx.SendBatch(ctx, batch).Close() }); err != nil {
			return res, store.MapErr(err)
		}
	}
	s.fireContactAdded(ctx, added)
	s.fireTagAdded(ctx, tagged)
	return res, nil
}

// ListContacts is GET /contacts.
func (s *Service) ListContacts(ctx context.Context, qp map[string]string) (map[string]any, error) {
	where, args := []string{"true"}, []any{}
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	for _, w := range strings.Fields(strings.ToLower(qp["q"])) {
		where = append(where, "(email || ' ' || first_name || ' ' || last_name || ' ' || company) ILIKE "+arg("%"+likeEscape(w)+"%"))
	}
	if qp["list_id"] != "" {
		where = append(where, arg(qp["list_id"])+" = ANY(list_ids)")
	}
	if qp["tag"] != "" {
		where = append(where, arg(qp["tag"])+" = ANY(tags)")
	}
	for _, f := range []string{"status", "country", "industry"} {
		if qp[f] != "" {
			where = append(where, f+" = "+arg(qp[f]))
		}
	}
	if qp["replied"] == "1" {
		where = append(where, "replied_at IS NOT NULL")
	}
	cond := strings.Join(where, " AND ")
	total, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM contacts WHERE `+cond, args...)
	if err != nil {
		return nil, err
	}
	size, _ := strconv.Atoi(qp["limit"])
	if size <= 0 {
		size = 50
	}
	size = min(size, 500)
	page, _ := strconv.Atoi(qp["page"])
	page = max(page, 1)
	rows, err := store.Rows(ctx, s.db.Pool, `SELECT * FROM contacts WHERE `+cond+` ORDER BY created_at DESC, id LIMIT `+arg(size)+` OFFSET `+arg((page-1)*size), args...)
	if err != nil {
		return nil, err
	}
	return map[string]any{"total": total, "rows": rows}, nil
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s)
}

// Facets are the filter values in use.
func (s *Service) Facets(ctx context.Context) (map[string]any, error) {
	get := func(q string) ([]string, error) {
		rows, err := store.Structs[struct {
			V string `db:"v"`
		}](ctx, s.db.Pool, q)
		out := []string{}
		for _, r := range rows {
			out = append(out, r.V)
		}
		return out, err
	}
	countries, err := get(`SELECT DISTINCT country AS v FROM contacts WHERE country <> '' ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	industries, err := get(`SELECT DISTINCT industry AS v FROM contacts WHERE industry <> '' ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	tags, err := get(`SELECT DISTINCT unnest(tags) AS v FROM contacts ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	return map[string]any{"countries": countries, "industries": industries, "tags": tags}, nil
}

// ContactDetail is GET /contacts/{id}: the contact with its messages, replies and WhatsApp.
func (s *Service) ContactDetail(ctx context.Context, id string) (store.Row, error) {
	c, err := store.One(ctx, s.db.Pool, `SELECT * FROM contacts WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	if c["messages"], err = store.Rows(ctx, s.db.Pool, `SELECT *, campaign_name AS campaign FROM messages WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 50`, id); err != nil {
		return nil, err
	}
	if c["replies"], err = store.Rows(ctx, s.db.Pool, `SELECT * FROM replies WHERE contact_id = $1 ORDER BY received_at DESC LIMIT 20`, id); err != nil {
		return nil, err
	}
	if c["whatsapp"], err = store.Rows(ctx, s.db.Pool, `SELECT * FROM whatsapp WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 30`, id); err != nil {
		return nil, err
	}
	return c, nil
}

// CreateContact is POST /contacts (overwrites fields the form sets).
func (s *Service) CreateContact(ctx context.Context, in ContactInput) (store.Row, error) {
	if !core.IsEmail(in.Email) {
		return nil, userErr("Invalid email: " + in.Email)
	}
	in.Tags = core.NormaliseTags(in.Tags)
	r, err := s.UpsertContacts(ctx, []ContactInput{in}, in.ListIDs, nil, "manual", true)
	if err != nil {
		return nil, err
	}
	return store.One(ctx, s.db.Pool, `SELECT * FROM contacts WHERE id = $1`, r.IDs[0])
}

// UpdateContact is PUT /contacts/{id}. Fields absent from the body are kept; a new e-mail
// moves the contact (and its history) to the new id.
func (s *Service) UpdateContact(ctx context.Context, id string, body map[string]any) (store.Row, error) {
	c, err := s.contact(ctx, s.db.Pool, id)
	if err != nil {
		return nil, err
	}
	next := *c
	for _, f := range core.ContactFields {
		if v, ok := body[f]; ok {
			setField(&next, f, strings.TrimSpace(str(v)))
		}
	}
	if v, ok := body["status"]; ok {
		st := strings.TrimSpace(str(v))
		if st != "subscribed" && st != "unsubscribed" && st != "bounced" {
			return nil, userErr("Status must be subscribed, unsubscribed or bounced")
		}
		next.Status = st
	}
	if v, ok := body["tags"]; ok {
		next.Tags = core.NormaliseTags(strList(v))
	}
	var added []pair
	if v, ok := body["list_ids"].([]any); ok {
		wanted := []string{}
		for _, l := range v {
			if ls := str(l); ls != "" && !contains(wanted, ls) {
				wanted = append(wanted, ls)
				if !contains(c.ListIDs, ls) {
					added = append(added, pair{"", ls})
				}
			}
		}
		next.ListIDs = wanted
	}
	newID := id
	if e := str(body["email"]); e != "" && core.EmailKey(e) != id {
		newID = core.EmailKey(e)
		if !core.IsEmail(newID) {
			return nil, userErr("Invalid email")
		}
	}
	next.Email = ""
	if core.IsEmail(newID) {
		next.Email = newID
	}
	next.PhoneKey = core.PhoneKey(next.Phone, s.Settings(ctx).DefaultCountryCode)
	var newTags []pair
	for _, t := range next.Tags {
		if !c.HasTag(t) {
			newTags = append(newTags, pair{newID, t})
		}
	}
	err = s.db.InTx(ctx, func(tx pgx.Tx) error {
		if newID != id {
			n, err := store.Count(ctx, tx, `SELECT count(*) FROM contacts WHERE id = $1`, newID)
			if err != nil {
				return err
			}
			if n > 0 {
				return userErr("Another contact already uses that email")
			}
			if _, err := tx.Exec(ctx, `UPDATE contacts SET id = $2 WHERE id = $1`, id, newID); err != nil {
				return err
			}
			for _, t := range []string{"messages", "replies", "runs", "whatsapp"} {
				if _, err := tx.Exec(ctx, `UPDATE `+t+` SET contact_id = $2 WHERE contact_id = $1`, id, newID); err != nil {
					return err
				}
			}
		}
		_, err := tx.Exec(ctx, `UPDATE contacts SET email = $2, first_name = $3, last_name = $4, company = $5, website = $6, phone = $7, phone_key = $8,
			country = $9, industry = $10, tags = $11, list_ids = $12, status = $13 WHERE id = $1`,
			newID, next.Email, next.FirstName, next.LastName, next.Company, next.Website, next.Phone, next.PhoneKey, next.Country, next.Industry, next.Tags, next.ListIDs, next.Status)
		return err
	})
	if err != nil {
		return nil, store.MapErr(err)
	}
	for i := range added {
		added[i].contact = newID
	}
	s.fireContactAdded(ctx, added)
	s.fireTagAdded(ctx, newTags)
	return store.One(ctx, s.db.Pool, `SELECT * FROM contacts WHERE id = $1`, newID)
}

func strList(v any) []string {
	switch x := v.(type) {
	case []any:
		out := []string{}
		for _, e := range x {
			out = append(out, str(e))
		}
		return out
	case string:
		return core.SplitTags(x)
	}
	return nil
}

func (s *Service) DeleteContact(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM contacts WHERE id = $1`, id))
}

// BulkContacts is POST /contacts/bulk.
func (s *Service) BulkContacts(ctx context.Context, action string, contactIDs []string, tag, listID string) (int, error) {
	var q string
	args := []any{contactIDs}
	switch action {
	case "add_to_list":
		_, err := s.AddToList(ctx, contactIDs, listID)
		return len(contactIDs), err
	case "delete":
		q = `DELETE FROM contacts WHERE id = ANY($1)`
	case "unsubscribe":
		q = `UPDATE contacts SET status = 'unsubscribed' WHERE id = ANY($1)`
	case "resubscribe":
		q = `UPDATE contacts SET status = 'subscribed' WHERE id = ANY($1)`
	case "add_tag":
		if strings.TrimSpace(tag) == "" {
			return 0, userErr("Enter a tag")
		}
		tag = strings.TrimSpace(tag)
		var tagged []pair
		rows, err := store.Structs[struct {
			ID string `db:"id"`
		}](ctx, s.db.Pool, `UPDATE contacts SET tags = array_append(tags, $2) WHERE id = ANY($1) AND NOT ($2 = ANY(tags)) RETURNING id`, contactIDs, tag)
		if err != nil {
			return 0, err
		}
		for _, r := range rows {
			tagged = append(tagged, pair{r.ID, tag})
		}
		s.fireTagAdded(ctx, tagged)
		return len(contactIDs), nil
	case "remove_from_list":
		q, args = `UPDATE contacts SET list_ids = array_remove(list_ids, $2) WHERE id = ANY($1)`, []any{contactIDs, listID}
	default:
		return 0, userErr("Unknown action " + action)
	}
	if _, err := s.db.Pool.Exec(ctx, q, args...); err != nil {
		return 0, err
	}
	return len(contactIDs), nil
}

// ImportContacts is POST /contacts/import: rows already parsed and mapped by the dashboard.
func (s *Service) ImportContacts(ctx context.Context, rows []map[string]string, listID string, tags []string, country, industry string) (map[string]any, error) {
	errs := []string{}
	skipped := 0
	good := []ContactInput{}
	for i, r := range rows {
		if !core.IsEmail(r["email"]) {
			skipped++
			if len(errs) < 20 {
				errs = append(errs, fmt.Sprintf("Row %d: invalid or missing email %q", i+2, r["email"]))
			}
			continue
		}
		in := ContactInput{Email: r["email"], FirstName: r["first_name"], LastName: r["last_name"], Company: r["company"], Website: r["website"],
			Phone: r["phone"], Country: r["country"], Industry: r["industry"], Tags: core.SplitTags(r["tags"]), Source: "import"}
		if in.Country == "" {
			in.Country = country
		}
		if in.Industry == "" {
			in.Industry = industry
		}
		good = append(good, in)
	}
	lists := []string{}
	if listID != "" {
		lists = append(lists, listID)
	}
	created, updated := 0, 0
	for i := 0; i < len(good); i += 500 {
		r, err := s.UpsertContacts(ctx, good[i:min(i+500, len(good))], lists, core.NormaliseTags(tags), "import", false)
		if err != nil {
			return nil, err
		}
		created += r.Created
		updated += r.Updated
	}
	return map[string]any{"total": len(rows), "created": created, "updated": updated, "skipped": skipped, "errors": errs}, nil
}

// ExportContacts is POST /contacts/export: every contact matching the filters, as CSV.
func (s *Service) ExportContacts(ctx context.Context, qp map[string]string) (map[string]any, error) {
	qp["limit"] = "500"
	var all []store.Row
	for p := 1; ; p++ {
		qp["page"] = strconv.Itoa(p)
		r, err := s.ListContacts(ctx, qp)
		if err != nil {
			return nil, err
		}
		rows := r["rows"].([]store.Row)
		all = append(all, rows...)
		if len(rows) < 500 || len(all) >= r["total"].(int) {
			break
		}
	}
	cols := []string{"email", "first_name", "last_name", "company", "website", "phone", "country", "industry", "tags", "status", "source", "replied_at", "created_at"}
	var b strings.Builder
	w := csv.NewWriter(&b)
	_ = w.Write(cols)
	for _, c := range all {
		rec := make([]string, len(cols))
		for i, k := range cols {
			if k == "tags" {
				rec[i] = strings.Join(strList(c["tags"]), ";")
			} else {
				rec[i] = str(c[k])
			}
		}
		_ = w.Write(rec)
	}
	w.Flush()
	return map[string]any{"csv": b.String(), "count": len(all)}, nil
}

// ---------------------------------------------------------------- lists

func (s *Service) Lists(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT l.*,
		(SELECT count(*) FROM contacts c WHERE l.id = ANY(c.list_ids)) AS contacts,
		(SELECT count(*) FROM contacts c WHERE l.id = ANY(c.list_ids) AND c.status = 'subscribed') AS subscribed
		FROM lists l ORDER BY lower(l.name)`)
}

func (s *Service) CreateList(ctx context.Context, name, description string) (store.Row, error) {
	if strings.TrimSpace(name) == "" {
		return nil, userErr("Name is required")
	}
	return store.One(ctx, s.db.Pool, `INSERT INTO lists (id, name, description, created_at) VALUES ($1,$2,$3,$4) RETURNING *`, ids.New(), strings.TrimSpace(name), description, s.now())
}

func (s *Service) UpdateList(ctx context.Context, id string, body map[string]any) (store.Row, error) {
	if v, ok := body["name"]; ok && v != nil {
		if strings.TrimSpace(str(v)) == "" {
			return nil, userErr("Name is required")
		}
		if err := store.Affected(s.db.Pool.Exec(ctx, `UPDATE lists SET name = $2 WHERE id = $1`, id, strings.TrimSpace(str(v)))); err != nil {
			return nil, err
		}
	}
	if v, ok := body["description"]; ok && v != nil {
		if err := store.Affected(s.db.Pool.Exec(ctx, `UPDATE lists SET description = $2 WHERE id = $1`, id, str(v))); err != nil {
			return nil, err
		}
	}
	return store.One(ctx, s.db.Pool, `SELECT * FROM lists WHERE id = $1`, id)
}

func (s *Service) DeleteList(ctx context.Context, id string) error {
	return s.db.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE contacts SET list_ids = array_remove(list_ids, $1) WHERE $1 = ANY(list_ids)`, id); err != nil {
			return err
		}
		return store.Affected(tx.Exec(ctx, `DELETE FROM lists WHERE id = $1`, id))
	})
}

// AddToList adds contacts to a list and fires contact_added for those not on it yet.
func (s *Service) AddToList(ctx context.Context, contactIDs []string, listID string) (int, error) {
	if listID == "" {
		return 0, userErr("Choose a list")
	}
	rows, err := store.Structs[struct {
		ID string `db:"id"`
	}](ctx, s.db.Pool, `UPDATE contacts SET list_ids = array_append(list_ids, $2) WHERE id = ANY($1) AND NOT ($2 = ANY(list_ids)) RETURNING id`, contactIDs, listID)
	if err != nil {
		return 0, err
	}
	var added []pair
	for _, r := range rows {
		added = append(added, pair{r.ID, listID})
	}
	s.fireContactAdded(ctx, added)
	return len(added), nil
}

func (s *Service) RemoveFromList(ctx context.Context, contactIDs []string, listID string) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET list_ids = array_remove(list_ids, $2) WHERE id = ANY($1)`, contactIDs, listID)
	return err
}
