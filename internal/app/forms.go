package app

import (
	"context"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Subscribe forms. Each has a hosted page at <PUBLIC_BASE_URL>/f/<id>; the same address takes
// the post of a form embedded on another website. A sign-up adds the form's lists and tags,
// after a double opt-in when the form asks for one, and fires form_submitted.

// FormFields are the fields a form may ask for besides the e-mail address.
var FormFields = []string{"first_name", "last_name", "phone", "company"}

func (s *Service) formOut(r store.Row) store.Row {
	r["url"] = s.baseURL + "/f/" + str(r["id"])
	return r
}

func (s *Service) Forms(ctx context.Context) ([]store.Row, error) {
	rows, err := store.Rows(ctx, s.db.Pool, `SELECT * FROM forms ORDER BY created_at DESC`)
	for _, r := range rows {
		s.formOut(r)
	}
	return rows, err
}

func (s *Service) Form(ctx context.Context, id string) (store.Row, error) {
	r, err := store.One(ctx, s.db.Pool, `SELECT * FROM forms WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	return s.formOut(r), nil
}

// formArgs validates a form into its column values.
func (s *Service) formArgs(ctx context.Context, b map[string]any) ([]any, error) {
	name := strings.TrimSpace(str(b["name"]))
	if name == "" {
		return nil, userErr("Give the form a name")
	}
	fields := []string{}
	for _, f := range strList(b["fields"]) {
		if contains(FormFields, f) && !contains(fields, f) {
			fields = append(fields, f)
		}
	}
	lists, err := s.knownLists(ctx, strList(b["list_ids"]))
	if err != nil {
		return nil, err
	}
	redirect := strings.TrimSpace(str(b["redirect_url"]))
	if redirect != "" && !isWebURL(redirect) {
		return nil, userErr("The redirect address must start with https:// or http://")
	}
	button := strings.TrimSpace(str(b["button_text"]))
	if button == "" {
		button = "Subscribe"
	}
	status := "active"
	if str(b["status"]) == "paused" {
		status = "paused"
	}
	doubleOptIn := true
	if v, ok := b["double_optin"]; ok {
		doubleOptIn = truthy(v)
	}
	return []any{
		name, core.Truncate(strings.TrimSpace(str(b["title"])), 200), core.Truncate(strings.TrimSpace(str(b["description"])), 2000), core.Truncate(button, 60),
		fields, lists, core.NormaliseTags(strList(b["tags"])), doubleOptIn, core.Truncate(strings.TrimSpace(str(b["consent_text"])), 500),
		core.Truncate(strings.TrimSpace(str(b["success_message"])), 1000), redirect, status,
	}, nil
}

func (s *Service) CreateForm(ctx context.Context, b map[string]any) (store.Row, error) {
	args, err := s.formArgs(ctx, b)
	if err != nil {
		return nil, err
	}
	id := ids.New()
	if _, err := s.db.Pool.Exec(ctx, `INSERT INTO forms (id, name, title, description, button_text, fields, list_ids, tags, double_optin, consent_text,
		success_message, redirect_url, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
		append(append([]any{id}, args...), s.now())...); err != nil {
		return nil, store.MapErr(err)
	}
	return s.Form(ctx, id)
}

func (s *Service) UpdateForm(ctx context.Context, id string, b map[string]any) (store.Row, error) {
	args, err := s.formArgs(ctx, b)
	if err != nil {
		return nil, err
	}
	if err := store.Affected(s.db.Pool.Exec(ctx, `UPDATE forms SET name = $2, title = $3, description = $4, button_text = $5, fields = $6, list_ids = $7,
		tags = $8, double_optin = $9, consent_text = $10, success_message = $11, redirect_url = $12, status = $13, updated_at = $14 WHERE id = $1`,
		append(append([]any{id}, args...), s.now())...)); err != nil {
		return nil, err
	}
	return s.Form(ctx, id)
}

func (s *Service) DeleteForm(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM forms WHERE id = $1`, id))
}

// PublicForm is what the hosted form page needs.
type PublicForm struct {
	ID             string   `db:"id"`
	Name           string   `db:"name"`
	Title          string   `db:"title"`
	Description    string   `db:"description"`
	ButtonText     string   `db:"button_text"`
	Fields         []string `db:"fields"`
	ListIDs        []string `db:"list_ids"`
	Tags           []string `db:"tags"`
	DoubleOptIn    bool     `db:"double_optin"`
	ConsentText    string   `db:"consent_text"`
	SuccessMessage string   `db:"success_message"`
	RedirectURL    string   `db:"redirect_url"`
	Status         string   `db:"status"`
}

func (s *Service) PublicForm(ctx context.Context, id string) (*PublicForm, error) {
	f, err := store.Struct[PublicForm](ctx, s.db.Pool, `SELECT * FROM forms WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// SubmitForm takes a sign-up: values are the posted fields. It answers with the outcome
// (subscribed, pending, ignored) and the form, for its thank-you message or redirect.
func (s *Service) SubmitForm(ctx context.Context, id string, values map[string]string) (string, *PublicForm, error) {
	f, err := s.PublicForm(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if f.Status != "active" {
		return "", f, userErr("This form is no longer accepting sign-ups.")
	}
	if !core.IsEmail(values["email"]) {
		return "", f, userErr("Enter a valid email address.")
	}
	if f.ConsentText != "" && values["consent"] == "" {
		return "", f, userErr("Please tick the box to agree before subscribing.")
	}
	in := InboundContact{Email: values["email"], Source: "form"}
	get := func(name string) string {
		if !contains(f.Fields, name) {
			return ""
		}
		return core.Truncate(strings.TrimSpace(values[name]), 200)
	}
	in.FirstName, in.LastName, in.Phone, in.Company = get("first_name"), get("last_name"), get("phone"), get("company")
	res, err := s.Subscribe(ctx, SubscribeInput{Contact: in, ListIDs: f.ListIDs, Tags: f.Tags, FormID: f.ID, DoubleOptIn: f.DoubleOptIn})
	if err != nil {
		return "", f, err
	}
	if _, err := s.db.Pool.Exec(ctx, `UPDATE forms SET submissions = submissions + 1 WHERE id = $1`, f.ID); err != nil {
		s.log.Warn("form submissions", "err", err)
	}
	return res.Outcome, f, nil
}
