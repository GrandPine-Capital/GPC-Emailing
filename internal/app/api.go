package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/catalog"
	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// The dashboard's routes (hosting/js/backend.js in the Firebase build), now on Postgres.

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// ---------------------------------------------------------------- meta & dashboard

// Meta is GET /meta: the worker's state for banners. The dashboard adds its own catalogue.
func (s *Service) Meta(ctx context.Context, role string) map[string]any {
	st := s.Settings(ctx)
	status := s.doc(ctx, "status")
	g, _ := s.GmailStatus(ctx)
	online := false
	if t, err := time.Parse(time.RFC3339, str(status["last_tick"])); err == nil {
		online = s.now().Sub(t) < 15*time.Minute
	}
	var lastTick any
	if v := str(status["last_tick"]); v != "" {
		lastTick = v
	}
	return map[string]any{
		"role": role, "dryRun": st.DryRun, "workerConfigured": truthy(g["connected"]) || st.DryRun, "gmailConnected": truthy(g["connected"]),
		"gmailConfigured": truthy(g["configured"]), "workerOnline": online, "lastTick": lastTick, "account": s.Account(ctx),
		"remainingToday": s.RemainingToday(ctx),
	}
}

func pct(n, of int) float64 {
	if of == 0 {
		return 0
	}
	return math.Round(float64(n)/float64(of)*1000) / 10
}

// Stats is GET /stats (the dashboard).
func (s *Service) Stats(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	counts := []struct {
		key, sql string
	}{
		{"contacts", `SELECT count(*) FROM contacts`},
		{"subscribed", `SELECT count(*) FROM contacts WHERE status = 'subscribed'`},
		{"lists", `SELECT count(*) FROM lists`},
		{"campaigns", `SELECT count(*) FROM campaigns`},
		{"activeAutomations", `SELECT count(*) FROM automations WHERE status = 'active'`},
		{"queued", `SELECT count(*) FROM messages WHERE status = 'queued'`},
	}
	for _, c := range counts {
		n, err := store.Count(ctx, s.db.Pool, c.sql)
		if err != nil {
			return nil, err
		}
		out[c.key] = n
	}
	daily, err := store.Rows(ctx, s.db.Pool, `SELECT day, sent, opens, clicks, replies FROM daily_stats WHERE day >= $1 ORDER BY day`, s.now().AddDate(0, 0, -30).Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	sum := func(k string) int {
		n := 0
		for _, d := range daily {
			n += int(num(d[k]))
		}
		return n
	}
	sent := sum("sent")
	out["sent30"], out["opened30"], out["clicked30"], out["replied30"] = sent, sum("opens"), sum("clicks"), sum("replies")
	out["openRate"], out["clickRate"], out["replyRate"] = pct(sum("opens"), sent), pct(sum("clicks"), sent), pct(sum("replies"), sent)
	out["daily"] = daily
	if out["recentReplies"], err = store.Rows(ctx, s.db.Pool, `SELECT * FROM replies ORDER BY received_at DESC LIMIT 5`); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------- templates

func (s *Service) Templates(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT * FROM templates ORDER BY is_standard DESC, updated_at DESC`)
}

func (s *Service) Template(ctx context.Context, id string) (store.Row, error) {
	return store.One(ctx, s.db.Pool, `SELECT * FROM templates WHERE id = $1`, id)
}

type templateFields struct {
	name, category, mode, subject, html string
	design                              any
}

// templateInput: the dashboard renders a drag-and-drop design to html before saving.
func templateInput(b map[string]any) templateFields {
	t := templateFields{name: strings.TrimSpace(str(b["name"])), category: str(b["category"]), mode: "dragdrop", subject: str(b["subject"]), html: str(b["html"])}
	if t.name == "" {
		t.name = "Untitled template"
	}
	if t.category == "" {
		t.category = "custom"
	}
	if str(b["mode"]) == "html" {
		t.mode = "html"
	} else {
		t.design = b["design"]
		if t.design == nil {
			t.design = map[string]any{"settings": map[string]any{}, "blocks": []any{}}
		}
	}
	return t
}

func (s *Service) CreateTemplate(ctx context.Context, b map[string]any) (store.Row, error) {
	t := templateInput(b)
	var design *string
	if t.design != nil {
		d := jsonText(t.design)
		design = &d
	}
	return store.One(ctx, s.db.Pool, `INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,false,$8,$8) RETURNING *`, ids.New(), t.name, t.category, t.mode, t.subject, design, t.html, s.now())
}

func (s *Service) UpdateTemplate(ctx context.Context, id string, b map[string]any) (store.Row, error) {
	t := templateInput(b)
	var design *string
	if t.design != nil {
		d := jsonText(t.design)
		design = &d
	}
	return store.One(ctx, s.db.Pool, `UPDATE templates SET name = $2, category = $3, mode = $4, subject = $5, design = $6::jsonb, html = $7, updated_at = $8
		WHERE id = $1 RETURNING *`, id, t.name, t.category, t.mode, t.subject, design, t.html, s.now())
}

func (s *Service) DuplicateTemplate(ctx context.Context, id string) (map[string]any, error) {
	nid := ids.New()
	err := store.Affected(s.db.Pool.Exec(ctx, `INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard, created_at, updated_at)
		SELECT $2, name || ' (copy)', category, mode, subject, design, html, false, $3, $3 FROM templates WHERE id = $1`, id, nid, s.now()))
	return map[string]any{"id": nid}, err
}

func (s *Service) DeleteTemplate(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM templates WHERE id = $1`, id))
}

// ---------------------------------------------------------------- campaigns

const campaignCols = `c.*, json_build_object('total', stat_total, 'queued', stat_queued, 'sent', stat_sent, 'failed', stat_failed,
	'skipped', stat_skipped, 'opened', stat_opened, 'clicked', stat_clicked, 'replied', stat_replied, 'unsubscribed', stat_unsubscribed) AS stats`

// campaignOut drops the stat_ columns and adds the rates (campaignStats in backend.js).
func campaignOut(c store.Row) store.Row {
	for k := range c {
		if strings.HasPrefix(k, "stat_") {
			delete(c, k)
		}
	}
	st, _ := c["stats"].(map[string]any)
	if st == nil {
		st = map[string]any{}
	}
	sent := int(num(st["sent"]))
	st["open_rate"] = pct(int(num(st["opened"])), sent)
	st["click_rate"] = pct(int(num(st["clicked"])), sent)
	st["reply_rate"] = pct(int(num(st["replied"])), sent)
	c["stats"] = st
	return c
}

func (s *Service) Campaigns(ctx context.Context) ([]store.Row, error) {
	rows, err := store.Rows(ctx, s.db.Pool, `SELECT `+campaignCols+`, coalesce(t.name, '') AS template_name
		FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id ORDER BY c.created_at DESC`)
	for _, r := range rows {
		campaignOut(r)
	}
	return rows, err
}

func (s *Service) Campaign(ctx context.Context, id string) (store.Row, error) {
	c, err := store.One(ctx, s.db.Pool, `SELECT `+campaignCols+` FROM campaigns c WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	campaignOut(c)
	if c["links"], err = store.Rows(ctx, s.db.Pool, `SELECT url, clicks, '' AS people FROM campaign_links WHERE campaign_id = $1 ORDER BY clicks DESC`, id); err != nil {
		return nil, err
	}
	lists := strList(c["list_ids"])
	n, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM contacts WHERE list_ids && $1 AND status = 'subscribed'`, lists)
	if err != nil {
		return nil, err
	}
	c["recipients"], c["recipients_estimate"] = n, false
	return c, nil
}

func (s *Service) CampaignMessages(ctx context.Context, id, filter string) ([]store.Row, error) {
	cond := map[string]string{"opened": " AND opened_at IS NOT NULL", "clicked": " AND clicked_at IS NOT NULL", "replied": " AND replied_at IS NOT NULL", "failed": " AND status = 'failed'"}[filter]
	return store.Rows(ctx, s.db.Pool, `SELECT *, name AS first_name, '' AS last_name FROM messages WHERE campaign_id = $1`+cond+` ORDER BY created_at LIMIT 5000`, id)
}

func campaignListIDs(v any) []string {
	out := []string{}
	for _, l := range strList(v) {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func (s *Service) CreateCampaign(ctx context.Context, b map[string]any) (store.Row, error) {
	name := strings.TrimSpace(str(b["name"]))
	if name == "" {
		name = "Untitled campaign"
	}
	c, err := store.One(ctx, s.db.Pool, `INSERT INTO campaigns (id, name, subject, preheader, template_id, from_name, from_email, reply_to, list_ids, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		ids.New(), name, str(b["subject"]), str(b["preheader"]), nilIfEmpty(str(b["template_id"])), str(b["from_name"]), str(b["from_email"]), str(b["reply_to"]), campaignListIDs(b["list_ids"]), s.now())
	if err != nil {
		return nil, err
	}
	return s.Campaign(ctx, str(c["id"]))
}

var campaignFields = []string{"name", "subject", "preheader", "template_id", "from_name", "from_email", "reply_to"}

func (s *Service) UpdateCampaign(ctx context.Context, id string, b map[string]any) (store.Row, error) {
	return s.updateCampaign(ctx, id, func(tx pgx.Tx, status string) error {
		if status != "draft" && status != "scheduled" {
			return userErr("Cannot edit a " + status + " campaign")
		}
		for _, f := range campaignFields {
			v, ok := b[f]
			if !ok {
				continue
			}
			var val any = str(v)
			if f == "template_id" {
				val = nilIfEmpty(str(v))
			}
			// f is from a fixed list.
			if _, err := tx.Exec(ctx, `UPDATE campaigns SET `+f+` = $2 WHERE id = $1`, id, val); err != nil {
				return err
			}
		}
		if v, ok := b["list_ids"]; ok && v != nil {
			if _, err := tx.Exec(ctx, `UPDATE campaigns SET list_ids = $2 WHERE id = $1`, id, campaignListIDs(v)); err != nil {
				return err
			}
		}
		return nil
	})
}

// updateCampaign locks the campaign row and runs fn with its status.
func (s *Service) updateCampaign(ctx context.Context, id string, fn func(tx pgx.Tx, status string) error) (store.Row, error) {
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM campaigns WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
			return mapNoRows(err)
		}
		return fn(tx, status)
	})
	if err != nil {
		return nil, err
	}
	return s.Campaign(ctx, id)
}

func (s *Service) DeleteCampaign(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM campaigns WHERE id = $1`, id)) // messages cascade
}

// SendCampaign marks the campaign for launch; the worker queues its recipients.
func (s *Service) SendCampaign(ctx context.Context, id string) error {
	_, err := s.updateCampaign(ctx, id, func(tx pgx.Tx, status string) error {
		var tpl *string
		var lists []string
		if err := tx.QueryRow(ctx, `SELECT template_id, list_ids FROM campaigns WHERE id = $1`, id).Scan(&tpl, &lists); err != nil {
			return err
		}
		switch {
		case tpl == nil || *tpl == "":
			return userErr("Choose a template first")
		case len(lists) == 0:
			return userErr("Choose at least one list")
		case status != "draft" && status != "scheduled":
			return userErr("Campaign is already " + status)
		}
		_, err := tx.Exec(ctx, `UPDATE campaigns SET status = 'launching', error = NULL WHERE id = $1`, id)
		return err
	})
	if err == nil {
		s.Wake()
	}
	return err
}

func (s *Service) ScheduleCampaign(ctx context.Context, id, when string) error {
	at, err := time.Parse(time.RFC3339, when)
	if err != nil {
		if at, err = time.Parse("2006-01-02T15:04", when); err != nil {
			return userErr("Invalid date")
		}
	}
	_, err = s.updateCampaign(ctx, id, func(tx pgx.Tx, status string) error {
		var tpl *string
		if err := tx.QueryRow(ctx, `SELECT template_id FROM campaigns WHERE id = $1`, id).Scan(&tpl); err != nil {
			return err
		}
		if status != "draft" && status != "scheduled" {
			return userErr("Only draft campaigns can be scheduled")
		}
		if tpl == nil || *tpl == "" {
			return userErr("Choose a template first")
		}
		_, err := tx.Exec(ctx, `UPDATE campaigns SET status = 'scheduled', scheduled_at = $2 WHERE id = $1`, id, at.UTC())
		return err
	})
	return err
}

// MoveCampaign changes status from → to when it is in from (unschedule, pause, resume).
func (s *Service) MoveCampaign(ctx context.Context, id, from, to string) error {
	_, err := s.updateCampaign(ctx, id, func(tx pgx.Tx, status string) error {
		if status != from {
			return nil
		}
		q := `UPDATE campaigns SET status = $2 WHERE id = $1`
		if to == "draft" {
			q = `UPDATE campaigns SET status = $2, scheduled_at = NULL WHERE id = $1`
		}
		_, err := tx.Exec(ctx, q, id, to)
		return err
	})
	if err == nil && to == "sending" {
		s.Wake()
	}
	return err
}

func (s *Service) DuplicateCampaign(ctx context.Context, id string) (map[string]any, error) {
	nid := ids.New()
	err := store.Affected(s.db.Pool.Exec(ctx, `INSERT INTO campaigns (id, name, subject, preheader, template_id, from_name, from_email, reply_to, list_ids, created_at)
		SELECT $2, name || ' (copy)', subject, preheader, template_id, from_name, from_email, reply_to, list_ids, $3 FROM campaigns WHERE id = $1`, id, nid, s.now()))
	return map[string]any{"id": nid}, err
}

// ---------------------------------------------------------------- automations

// ValidateAutomation checks the trigger and steps (validateAutomation in backend.js).
func ValidateAutomation(b map[string]any) error {
	if !catalog.IsTrigger(str(b["trigger_type"])) {
		return userErr("Choose a valid trigger")
	}
	steps, _ := b["steps"].([]any)
	for i, raw := range steps {
		st, _ := raw.(map[string]any)
		n := i + 1
		t := str(st["type"])
		switch {
		case !catalog.IsStepType(t):
			return userErr(fmt.Sprintf("Step %d: unknown type", n))
		case t == "send_email" && str(st["template_id"]) == "":
			return userErr(fmt.Sprintf("Step %d: choose a template", n))
		case t == "webhook" && !regexp.MustCompile(`^https?://`).MatchString(str(st["url"])):
			return userErr(fmt.Sprintf("Step %d: webhook URL required", n))
		case t == "send_whatsapp" && str(st["text"]) == "" && str(st["template_name"]) == "":
			return userErr(fmt.Sprintf("Step %d: enter a WhatsApp message (or a template name for the Cloud API)", n))
		case t == "notify" && (str(st["channel"]) == "whatsapp" || str(st["channel"]) == "both") && str(st["whatsapp"]) == "":
			return userErr(fmt.Sprintf("Step %d: enter the WhatsApp number to notify", n))
		case (t == "add_tag" || t == "remove_tag") && str(st["tag"]) == "":
			return userErr(fmt.Sprintf("Step %d: enter a tag", n))
		case (t == "add_to_list" || t == "remove_from_list") && str(st["list_id"]) == "":
			return userErr(fmt.Sprintf("Step %d: choose a list", n))
		case t == "stop_if" && (str(st["condition"]) == "has_tag" || str(st["condition"]) == "not_has_tag") && str(st["tag"]) == "":
			return userErr(fmt.Sprintf("Step %d: enter the tag to check", n))
		}
	}
	return nil
}

const automationCols = `a.*, coalesce((SELECT json_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM runs r
	WHERE r.automation_id = a.id GROUP BY status) x), '{}'::json) AS runs`

func (s *Service) Automations(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT `+automationCols+` FROM automations a ORDER BY created_at DESC`)
}

func (s *Service) Automation(ctx context.Context, id string) (store.Row, error) {
	a, err := store.One(ctx, s.db.Pool, `SELECT `+automationCols+` FROM automations a WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	a["recent"], err = store.Rows(ctx, s.db.Pool, `SELECT * FROM runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 50`, id)
	return a, err
}

func automationDoc(b map[string]any) (name, trigger, cfg, steps, status string, reentry bool) {
	name = strings.TrimSpace(str(b["name"]))
	if name == "" {
		name = "Untitled automation"
	}
	c := b["trigger_config"]
	if c == nil {
		c = map[string]any{}
	}
	st := b["steps"]
	if st == nil {
		st = []any{}
	}
	status = "paused"
	if str(b["status"]) == "active" {
		status = "active"
	}
	return name, str(b["trigger_type"]), jsonText(c), jsonText(st), status, truthy(b["allow_reentry"])
}

func (s *Service) CreateAutomation(ctx context.Context, b map[string]any) (store.Row, error) {
	if err := ValidateAutomation(b); err != nil {
		return nil, err
	}
	name, trigger, cfg, steps, status, reentry := automationDoc(b)
	return store.One(ctx, s.db.Pool, `INSERT INTO automations (id, name, trigger_type, trigger_config, steps, status, allow_reentry, created_at, updated_at)
		VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$8) RETURNING *`, ids.New(), name, trigger, cfg, steps, status, reentry, s.now())
}

func (s *Service) UpdateAutomation(ctx context.Context, id string, b map[string]any) (store.Row, error) {
	if err := ValidateAutomation(b); err != nil {
		return nil, err
	}
	name, trigger, cfg, steps, status, reentry := automationDoc(b)
	return store.One(ctx, s.db.Pool, `UPDATE automations SET name = $2, trigger_type = $3, trigger_config = $4::jsonb, steps = $5::jsonb, status = $6,
		allow_reentry = $7, updated_at = $8 WHERE id = $1 RETURNING *`, id, name, trigger, cfg, steps, status, reentry, s.now())
}

func (s *Service) SetAutomationStatus(ctx context.Context, id, status string) error {
	err := store.Affected(s.db.Pool.Exec(ctx, `UPDATE automations SET status = $2, updated_at = $3 WHERE id = $1`, id, status, s.now()))
	if err == nil && status == "active" {
		s.Wake()
	}
	return err
}

func (s *Service) DeleteAutomation(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM automations WHERE id = $1`, id)) // runs cascade
}

func (s *Service) StopRun(ctx context.Context, id string) error {
	n, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM runs WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return s.setRunStatus(ctx, id, "stopped")
}

// ---------------------------------------------------------------- replies & inbox

func (s *Service) Replies(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT *, campaign_name AS campaign FROM replies ORDER BY received_at DESC LIMIT 200`)
}

func (s *Service) Inbound(ctx context.Context, limit int) ([]store.Row, error) {
	if limit <= 0 {
		limit = 50
	}
	return store.Rows(ctx, s.db.Pool, `SELECT * FROM inbound ORDER BY received_at DESC LIMIT $1`, min(limit, 200))
}

// ---------------------------------------------------------------- lead finder

func (s *Service) StartLeadSearch(ctx context.Context, b map[string]any) (map[string]any, error) {
	p := leadParams{
		Countries: nonEmptyList(strList(b["countries"])), Industries: nonEmptyList(strList(b["industries"])),
		Keywords: strings.TrimSpace(str(b["keywords"])), Sources: nonEmptyList(strList(b["sources"])),
		URLs:  nonEmptyList(regexp.MustCompile(`[\s,]+`).Split(str(b["urls"]), -1)),
		Limit: min(intOr(b["limit"], 100), 1000), PerSiteMaxEmails: intOr(b["perSiteMaxEmails"], 3), Pages: min(intOr(b["pages"], 2), 5),
	}
	if len(p.Sources) == 0 {
		p.Sources = []string{"web"}
	}
	if len(p.Countries) == 0 && len(p.Industries) == 0 && p.Keywords == "" && len(p.URLs) == 0 {
		return nil, userErr("Choose at least one country, industry, keyword or URL")
	}
	id := ids.New()
	_, err := s.db.Pool.Exec(ctx, `INSERT INTO lead_searches (id, params, status, progress, created_at) VALUES ($1,$2::jsonb,'queued','Waiting for the worker to start…',$3)`,
		id, jsonText(p), s.now())
	if err != nil {
		return nil, err
	}
	s.Wake()
	return map[string]any{"id": id}, nil
}

func nonEmptyList(in []string) []string {
	out := []string{}
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func intOr(v any, def int) int {
	n := int(num(v))
	if n <= 0 {
		return def
	}
	return n
}

func (s *Service) LeadSearches(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT id, params, status, progress, results_count, error, created_at, finished_at FROM lead_searches ORDER BY created_at DESC LIMIT 50`)
}

func (s *Service) LeadSearch(ctx context.Context, id string) (store.Row, error) {
	r, err := store.One(ctx, s.db.Pool, `SELECT id, params, status, progress, results_count, error, created_at, finished_at FROM lead_searches WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	r["leads"], err = store.Rows(ctx, s.db.Pool, `SELECT l.*, EXISTS (SELECT 1 FROM contacts c WHERE c.id = l.email) AS in_contacts
		FROM leads l WHERE search_id = $1 ORDER BY created_at, email`, id)
	return r, err
}

func (s *Service) DeleteLeadSearch(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM lead_searches WHERE id = $1`, id))
}

// ImportLeads adds chosen leads as contacts (tagged lead-finder).
func (s *Service) ImportLeads(ctx context.Context, searchID string, leadIDs []string, listID string, tags []string) (UpsertResult, error) {
	type lead struct {
		Email     string `db:"email"`
		FirstName string `db:"first_name"`
		LastName  string `db:"last_name"`
		Company   string `db:"company"`
		Website   string `db:"website"`
		Country   string `db:"country"`
		Industry  string `db:"industry"`
		Source    string `db:"source"`
	}
	rows, err := store.Structs[lead](ctx, s.db.Pool, `SELECT * FROM leads WHERE search_id = $1 AND id = ANY($2)`, searchID, leadIDs)
	if err != nil {
		return UpsertResult{}, err
	}
	in := []ContactInput{}
	for _, l := range rows {
		in = append(in, ContactInput{Email: l.Email, FirstName: l.FirstName, LastName: l.LastName, Company: l.Company, Website: l.Website,
			Country: l.Country, Industry: l.Industry, Source: "lead:" + l.Source})
	}
	lists := []string{}
	if listID != "" {
		lists = append(lists, listID)
	}
	r, err := s.UpsertContacts(ctx, in, lists, append(core.NormaliseTags(tags), "lead-finder"), "lead", false)
	if err != nil {
		return r, err
	}
	_, err = s.db.Pool.Exec(ctx, `UPDATE leads SET imported = true WHERE search_id = $1 AND id = ANY($2)`, searchID, leadIDs)
	return r, err
}

// ---------------------------------------------------------------- auto-reply rules

const autoreplyCols = `*, sort_order AS "order"`

func (s *Service) AutoReplies(ctx context.Context) ([]store.Row, error) {
	return store.Rows(ctx, s.db.Pool, `SELECT `+autoreplyCols+` FROM autoreplies ORDER BY sort_order, created_at`)
}

func (s *Service) AutoReplyRule(ctx context.Context, id string) (store.Row, error) {
	return store.One(ctx, s.db.Pool, `SELECT `+autoreplyCols+` FROM autoreplies WHERE id = $1`, id)
}

var hhmmRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// autoreplyArgs validates a rule (autoreplyDoc in backend.js) into the column values.
func (s *Service) autoreplyArgs(ctx context.Context, b map[string]any) ([]any, error) {
	if str(b["template_id"]) == "" {
		return nil, userErr("Choose the email template to reply with")
	}
	sch, _ := b["schedule"].(map[string]any)
	if sch == nil {
		sch = map[string]any{}
	}
	mode := str(sch["mode"])
	if mode != "outside" && mode != "inside" {
		mode = "always"
	}
	days := []int{}
	for _, d := range strList(sch["days"]) {
		if n, err := strconv.Atoi(d); err == nil && n >= 1 && n <= 7 {
			days = append(days, n)
		}
	}
	if _, ok := sch["days"]; !ok {
		days = []int{1, 2, 3, 4, 5}
	}
	start, end := str(sch["start"]), str(sch["end"])
	if start == "" {
		start = "09:00"
	}
	if end == "" {
		end = "18:00"
	}
	if !hhmmRe.MatchString(start) || !hhmmRe.MatchString(end) {
		return nil, userErr("Office hours must look like 09:00")
	}
	audience := str(b["audience"])
	if audience != "new" && audience != "contacts" {
		audience = "all"
	}
	fromMode := str(b["from_mode"])
	if fromMode != "default" && fromMode != "custom" {
		fromMode = "recipient"
	}
	fromEmail := ""
	if fromMode == "custom" {
		fromEmail = core.EmailKey(str(b["from_email"]))
	}
	tz := str(b["timezone"])
	if tz == "" {
		tz = s.Settings(ctx).Timezone
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return nil, userErr("Unknown time zone " + tz)
	}
	notify := ""
	if core.IsEmail(str(b["notify_email"])) {
		notify = core.EmailKey(str(b["notify_email"]))
	}
	keep := true
	if v, ok := b["keep_thread"]; ok && v == false {
		keep = false
	}
	name := strings.TrimSpace(str(b["name"]))
	if name == "" {
		name = "Auto-reply"
	}
	return []any{
		name, truthy(b["enabled"]), int(num(b["order"])), core.EmailKey(str(b["to_address"])), audience,
		strings.TrimSpace(str(b["keywords"])), strings.TrimSpace(str(b["exclude"])), str(b["template_id"]), keep, fromMode, fromEmail,
		max(1, int(num(b["cooldown_hours"]))), jsonText(map[string]any{"mode": mode, "days": days, "start": start, "end": end}), tz,
		truthy(b["create_contact"]), str(b["list_id"]), strings.Join(core.NormaliseTags(strList(b["tags"])), ", "), notify,
	}, nil
}

func (s *Service) CreateAutoReply(ctx context.Context, b map[string]any) (map[string]any, error) {
	args, err := s.autoreplyArgs(ctx, b)
	if err != nil {
		return nil, err
	}
	if num(b["cooldown_hours"]) == 0 {
		args[11] = 24
	}
	id := ids.New()
	_, err = s.db.Pool.Exec(ctx, `INSERT INTO autoreplies (id, name, enabled, sort_order, to_address, audience, keywords, exclude, template_id, keep_thread,
		from_mode, from_email, cooldown_hours, schedule, timezone, create_contact, list_id, tags, notify_email, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$20)`, append(append([]any{id}, args...), s.now())...)
	if err == nil && truthy(b["enabled"]) {
		s.Wake()
	}
	return map[string]any{"id": id}, store.MapErr(err)
}

func (s *Service) UpdateAutoReply(ctx context.Context, id string, b map[string]any) (map[string]any, error) {
	args, err := s.autoreplyArgs(ctx, b)
	if err != nil {
		return nil, err
	}
	if num(b["cooldown_hours"]) == 0 {
		args[11] = 24
	}
	err = store.Affected(s.db.Pool.Exec(ctx, `UPDATE autoreplies SET name = $2, enabled = $3, sort_order = $4, to_address = $5, audience = $6, keywords = $7,
		exclude = $8, template_id = $9, keep_thread = $10, from_mode = $11, from_email = $12, cooldown_hours = $13, schedule = $14::jsonb, timezone = $15,
		create_contact = $16, list_id = $17, tags = $18, notify_email = $19, updated_at = $20 WHERE id = $1`, append(append([]any{id}, args...), s.now())...))
	return map[string]any{"id": id}, err
}

func (s *Service) ToggleAutoReply(ctx context.Context, id string) (map[string]any, error) {
	var enabled bool
	err := s.db.Pool.QueryRow(ctx, `UPDATE autoreplies SET enabled = NOT enabled, updated_at = $2 WHERE id = $1 RETURNING enabled`, id, s.now()).Scan(&enabled)
	if err != nil {
		return nil, mapNoRows(err)
	}
	if enabled {
		s.Wake()
	}
	return map[string]any{"enabled": enabled}, nil
}

func (s *Service) DeleteAutoReply(ctx context.Context, id string) error {
	return store.Affected(s.db.Pool.Exec(ctx, `DELETE FROM autoreplies WHERE id = $1`, id))
}

// ---------------------------------------------------------------- uploads

var allowedImages = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// MaxUpload is the largest image the builder accepts.
const MaxUpload = 5 << 20

// SaveUpload stores a builder image and returns its public URL.
func (s *Service) SaveUpload(ctx context.Context, name, mime string, data []byte, by string) (string, error) {
	if !allowedImages[mime] {
		return "", userErr("Upload a PNG, JPG, GIF or WebP image")
	}
	if len(data) > MaxUpload {
		return "", userErr("Image is larger than 5 MB")
	}
	id := ids.New()
	if _, err := s.db.Pool.Exec(ctx, `INSERT INTO uploads (id, name, mime_type, data, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		id, core.Truncate(name, 200), mime, data, by, s.now()); err != nil {
		return "", err
	}
	return s.baseURL + "/img/" + id, nil
}

// Upload serves a builder image.
func (s *Service) Upload(ctx context.Context, id string) (mime string, data []byte, err error) {
	err = s.db.Pool.QueryRow(ctx, `SELECT mime_type, data FROM uploads WHERE id = $1`, id).Scan(&mime, &data)
	return mime, data, mapNoRows(err)
}
