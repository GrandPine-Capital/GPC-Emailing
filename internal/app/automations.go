package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Event is what fired a trigger. It is kept in the run's context and posted by webhook steps,
// with the field names the Firebase build used.
type Event struct {
	ContactID      string `json:"contactId"`
	CampaignID     string `json:"campaignId,omitempty"`
	TemplateID     string `json:"templateId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	FromAutomation string `json:"fromAutomation,omitempty"`
	ListID         string `json:"listId,omitempty"`
	Tag            string `json:"tag,omitempty"`
	URL            string `json:"url,omitempty"`
	Text           string `json:"text,omitempty"`
	Event          string `json:"event,omitempty"`
	Subject        string `json:"subject,omitempty"`
	RFCMessageID   string `json:"rfc_message_id,omitempty"`
	To             string `json:"to,omitempty"`
}

func (s *Service) activeAutomations(ctx context.Context) ([]Automation, error) {
	return store.Structs[Automation](ctx, s.db.Pool, `SELECT * FROM automations WHERE status = 'active' ORDER BY created_at`)
}

func has(v any) bool { return v != nil && str(v) != "" }

// matches checks a trigger's filters against the event (Automations.matches).
func matches(cfg map[string]any, ev Event) bool {
	if has(cfg["campaign_id"]) && str(cfg["campaign_id"]) != ev.CampaignID {
		return false
	}
	if has(cfg["template_id"]) && str(cfg["template_id"]) != ev.TemplateID {
		return false
	}
	if has(cfg["list_id"]) && str(cfg["list_id"]) != ev.ListID {
		return false
	}
	if has(cfg["tag"]) && str(cfg["tag"]) != ev.Tag {
		return false
	}
	if has(cfg["event"]) && str(cfg["event"]) != ev.Event {
		return false
	}
	if has(cfg["url_contains"]) && !strings.Contains(strings.ToLower(ev.URL), strings.ToLower(str(cfg["url_contains"]))) {
		return false
	}
	if has(cfg["keywords"]) {
		text := strings.ToLower(ev.Text)
		words := core.Words(str(cfg["keywords"]))
		if len(words) > 0 {
			found := false
			for _, w := range words {
				if strings.Contains(text, w) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	return true
}

func (s *Service) startRun(ctx context.Context, q store.Q, a Automation, contactID string, trigger string, ev Event) (string, error) {
	c, err := s.contact(ctx, q, contactID)
	if IsNotFound(err) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	runCtx, _ := json.Marshal(map[string]any{"trigger": trigger, "event": ev})
	id := ids.New()
	_, err = q.Exec(ctx, `INSERT INTO runs (id, automation_id, automation_name, contact_id, email, next_run_at, context, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$6,$6)`, id, a.ID, a.Name, contactID, c.Email, s.now(), string(runCtx))
	return id, store.MapErr(err)
}

func (s *Service) setRunStatus(ctx context.Context, runID, status string) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE runs SET status = $2, updated_at = $3 WHERE id = $1 AND status = 'active'`, runID, status, s.now())
	return err
}

// Fire raises a trigger: it starts a run in every active automation that matches. Errors are
// logged, never returned: an automation must not undo what triggered it (Automations.fire).
func (s *Service) Fire(ctx context.Context, trigger string, ev Event) []string {
	if ev.ContactID == "" {
		return nil
	}
	autos, err := s.activeAutomations(ctx)
	if err != nil {
		s.log.Error("automations", "err", err)
		return nil
	}
	if trigger == "reply_received" || trigger == "whatsapp_received" {
		// Sequences flagged "stop on reply" end as soon as the contact replies.
		for _, a := range autos {
			if truthy(a.TriggerConfig["stop_on_reply"]) {
				if _, err := s.db.Pool.Exec(ctx, `UPDATE runs SET status = 'stopped', updated_at = $3 WHERE automation_id = $1 AND contact_id = $2 AND status = 'active'`,
					a.ID, ev.ContactID, s.now()); err != nil {
					s.log.Error("stop on reply", "err", err)
				}
			}
		}
	}
	var created []string
	for _, a := range autos {
		if a.TriggerType != trigger || (ev.FromAutomation != "" && ev.FromAutomation == a.ID) || !matches(a.TriggerConfig, ev) {
			continue
		}
		var prior, active int
		if err := s.db.Pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE status = 'active') FROM runs WHERE automation_id = $1 AND contact_id = $2`,
			a.ID, ev.ContactID).Scan(&prior, &active); err != nil {
			s.log.Error("automation runs", "err", err)
			continue
		}
		if (a.AllowReentry && active > 0) || (!a.AllowReentry && prior > 0) {
			continue
		}
		id, err := s.startRun(ctx, s.db.Pool, a, ev.ContactID, trigger, ev)
		if err != nil {
			s.log.Error("start run", "automation", a.ID, "err", err)
			continue
		}
		if id != "" {
			created = append(created, id)
		}
	}
	if len(created) > 0 {
		s.Wake()
	}
	return created
}

// stopRunsFor stops every active run of a contact (unsubscribed, bounced).
func (s *Service) stopRunsFor(ctx context.Context, contactID string) {
	if _, err := s.db.Pool.Exec(ctx, `UPDATE runs SET status = 'stopped', updated_at = $2 WHERE contact_id = $1 AND status = 'active'`, contactID, s.now()); err != nil {
		s.log.Error("stop runs", "err", err)
	}
}

// conditionMet evaluates a stop_if condition since the run started.
func (s *Service) conditionMet(ctx context.Context, condition string, run Run, tag string) (bool, error) {
	c, err := s.contact(ctx, s.db.Pool, run.ContactID)
	if IsNotFound(err) {
		c = &Contact{}
	} else if err != nil {
		return false, err
	}
	since := run.CreatedAt
	anyMsg := func(col string) (bool, error) {
		n, err := store.Count(ctx, s.db.Pool, `SELECT count(*) FROM messages WHERE contact_id = $1 AND `+col+` >= $2`, run.ContactID, since)
		return n > 0, err
	}
	switch condition {
	case "replied":
		return c.RepliedAt != nil && !c.RepliedAt.Before(since), nil
	case "not_replied":
		ok, err := s.conditionMet(ctx, "replied", run, tag)
		return !ok, err
	case "opened":
		return anyMsg("opened_at")
	case "not_opened":
		ok, err := anyMsg("opened_at")
		return !ok, err
	case "clicked":
		return anyMsg("clicked_at")
	case "not_clicked":
		ok, err := anyMsg("clicked_at")
		return !ok, err
	case "unsubscribed":
		return c.Status != "subscribed", nil
	case "has_tag":
		return c.HasTag(tag), nil
	case "not_has_tag":
		return !c.HasTag(tag), nil
	}
	return false, nil
}

type stepResult struct {
	note      string
	stop      bool
	waitUntil *time.Time
}

var unitDur = map[string]time.Duration{"minutes": time.Minute, "hours": time.Hour, "days": 24 * time.Hour}

var reRe = regexp.MustCompile(`(?i)^\s*re\s*:\s*`)

func (s *Service) whatsappVars(ctx context.Context, c *Contact) map[string]string {
	st := s.Settings(ctx)
	v := core.ContactVars(c.Fields())
	v["sender_name"], v["company_address"] = st.FromName, st.CompanyAddress
	return v
}

// executeStep runs one step of a run (Automations.executeStep).
func (s *Service) executeStep(ctx context.Context, step map[string]any, run *Run, rc map[string]any) (stepResult, error) {
	c, err := s.contact(ctx, s.db.Pool, run.ContactID)
	if IsNotFound(err) {
		return stepResult{stop: true, note: "contact deleted"}, nil
	} else if err != nil {
		return stepResult{}, err
	}
	trig, _ := rc["event"].(map[string]any)
	if trig == nil {
		trig = map[string]any{}
	}
	switch str(step["type"]) {
	case "wait":
		if ws, ok := rc["waiting_step"]; ok && int(num(ws)) == run.StepIndex {
			delete(rc, "waiting_step")
			return stepResult{note: "wait finished"}, nil
		}
		unit := str(step["unit"])
		d, ok := unitDur[unit]
		if !ok {
			d, unit = unitDur["days"], "days"
		}
		until := s.now().Add(time.Duration(max(0, num(step["amount"])) * float64(d)))
		rc["waiting_step"] = run.StepIndex
		return stepResult{waitUntil: &until, note: fmt.Sprintf("waiting %s %s", str(step["amount"]), unit)}, nil

	case "send_email":
		if c.Status != "subscribed" {
			return stepResult{stop: true, note: "contact " + c.Status}, nil
		}
		if !core.IsEmail(c.Email) {
			return stepResult{note: "skipped: contact has no email address"}, nil
		}
		if s.RemainingToday(ctx) <= 0 {
			until := s.now().Add(time.Hour)
			return stepResult{waitUntil: &until, note: "daily sending limit reached, retrying later"}, nil
		}
		if err := s.canSend(ctx); err != nil {
			until := s.now().Add(time.Hour)
			return stepResult{waitUntil: &until, note: "cannot send yet (" + err.Error() + "), retrying later"}, nil
		}
		t, err := s.template(ctx, str(step["template_id"]))
		if IsNotFound(err) {
			return stepResult{}, fmt.Errorf("template %s not found", str(step["template_id"]))
		} else if err != nil {
			return stepResult{}, err
		}
		subject := str(step["subject"])
		if subject == "" {
			subject = t.Subject
		}
		var th threadOpts
		if truthy(step["reply_in_thread"]) && str(trig["messageId"]) != "" {
			if orig, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE id = $1`, str(trig["messageId"])); err == nil && orig.RFCMessageID != nil {
				th.InReplyTo = *orig.RFCMessageID
				if str(step["subject"]) == "" {
					if regexp.MustCompile(`(?i)^re:`).MatchString(orig.Subject) {
						subject = orig.Subject
					} else {
						base := orig.Subject
						if base == "" {
							base = subject
						}
						subject = "Re: " + base
					}
				}
			}
		} else if truthy(step["reply_in_thread"]) && str(trig["rfc_message_id"]) != "" {
			// Reply to an incoming e-mail that was not a reply to one of ours.
			th = threadOpts{InReplyTo: str(trig["rfc_message_id"])}
			if str(step["subject"]) == "" {
				base := str(trig["subject"])
				if base == "" {
					base = subject
				}
				subject = "Re: " + reRe.ReplaceAllString(base, "")
			}
		}
		msgID, err := s.insertMessage(ctx, s.db.Pool, newMessage{Contact: c, TemplateID: t.ID, Subject: subject, AutomationID: run.AutomationID, RunID: run.ID, FromEmail: str(step["from_email"])})
		if err != nil {
			return stepResult{}, err
		}
		status, err := s.deliver(ctx, msgID, th)
		if status == "failed" {
			if err == nil {
				err = errors.New("send failed")
			}
			return stepResult{}, err
		}
		return stepResult{note: fmt.Sprintf("email %q %s", subject, status)}, nil

	case "send_whatsapp":
		if c.Status == "unsubscribed" && !truthy(step["ignore_unsubscribe"]) {
			return stepResult{stop: true, note: "contact unsubscribed"}, nil
		}
		vars := s.whatsappVars(ctx, c)
		text := core.Merge(str(step["text"]), vars, false)
		var params []string
		for _, p := range strings.Split(str(step["params"]), "|") {
			if v := core.Merge(strings.TrimSpace(p), vars, false); v != "" {
				params = append(params, v)
			}
		}
		provider := str(step["provider"])
		if err := s.SendWhatsApp(ctx, s.contactPhone(ctx, c), WhatsAppOpts{Provider: provider, Text: text, Template: str(step["template_name"]), Language: str(step["language"]), Params: params}); err != nil {
			return stepResult{}, err
		}
		logged := text
		if logged == "" {
			logged = "template " + str(step["template_name"])
		}
		s.logWhatsApp(ctx, c, "out", logged, run.AutomationID)
		if provider == "" {
			provider = s.Settings(ctx).WhatsAppProvider
		}
		return stepResult{note: "WhatsApp sent via " + provider}, nil

	case "chatdaddy_contact":
		var tags []string
		vars := s.whatsappVars(ctx, c)
		for _, t := range strings.Split(str(step["tags"]), ",") {
			if v := core.Merge(strings.TrimSpace(t), vars, false); v != "" {
				tags = append(tags, v)
			}
		}
		if truthy(step["include_contact_tags"]) {
			tags = append(tags, c.Tags...)
		}
		if err := s.chatdaddyUpsert(ctx, c, tags); err != nil {
			return stepResult{}, err
		}
		note := "synced to ChatDaddy"
		if len(tags) > 0 {
			note += " with tags " + strings.Join(tags, ", ")
		}
		return stepResult{note: note}, nil

	case "stop_if":
		cond := str(step["condition"])
		met, err := s.conditionMet(ctx, cond, *run, str(step["tag"]))
		if err != nil {
			return stepResult{}, err
		}
		if met {
			return stepResult{stop: true, note: "stopped: " + cond}, nil
		}
		return stepResult{note: "condition " + cond + " not met"}, nil

	case "add_tag":
		tag := str(step["tag"])
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET tags = array_append(tags, $2) WHERE id = $1 AND NOT ($2 = ANY(tags))`, c.ID, tag); err != nil {
			return stepResult{}, err
		}
		if !c.HasTag(tag) {
			s.Fire(ctx, "tag_added", Event{ContactID: c.ID, Tag: tag, FromAutomation: run.AutomationID})
		}
		return stepResult{note: "tag +" + tag}, nil

	case "remove_tag":
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET tags = array_remove(tags, $2) WHERE id = $1`, c.ID, str(step["tag"])); err != nil {
			return stepResult{}, err
		}
		return stepResult{note: "tag -" + str(step["tag"])}, nil

	case "add_to_list":
		listID := str(step["list_id"])
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET list_ids = array_append(list_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(list_ids))`, c.ID, listID); err != nil {
			return stepResult{}, err
		}
		if !contains(c.ListIDs, listID) {
			s.Fire(ctx, "contact_added", Event{ContactID: c.ID, ListID: listID})
		}
		return stepResult{note: "added to list"}, nil

	case "remove_from_list":
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET list_ids = array_remove(list_ids, $2) WHERE id = $1`, c.ID, str(step["list_id"])); err != nil {
			return stepResult{}, err
		}
		return stepResult{note: "removed from list"}, nil

	case "update_field":
		field, value := str(step["field"]), str(step["value"])
		if field == "status" {
			if value != "subscribed" && value != "unsubscribed" && value != "bounced" {
				return stepResult{}, fmt.Errorf("status must be subscribed, unsubscribed or bounced, not %q", value)
			}
		} else if !core.IsContactField(field) {
			return stepResult{}, fmt.Errorf("cannot update field %s", field)
		}
		// field is one of a fixed list, so it is safe in the statement.
		if _, err := s.db.Pool.Exec(ctx, `UPDATE contacts SET `+field+` = $2 WHERE id = $1`, c.ID, value); err != nil {
			return stepResult{}, err
		}
		if field == "phone" {
			_, _ = s.db.Pool.Exec(ctx, `UPDATE contacts SET phone_key = $2 WHERE id = $1`, c.ID, core.PhoneKey(value, s.Settings(ctx).DefaultCountryCode))
		}
		return stepResult{note: field + " = " + value}, nil

	case "notify":
		reply := ""
		if t := str(trig["text"]); t != "" {
			reply = "\n\nMessage:\n" + core.Truncate(t, 2000)
		}
		who := c.Email
		if who == "" {
			who = c.Phone
		}
		if who == "" {
			who = c.ID
		}
		company := ""
		if c.Company != "" {
			company = ", " + c.Company
		}
		name := str(rc["automation_name"])
		summary := fmt.Sprintf("Automation %q (%s) for %s (%s%s).%s\n\nOpen: %s/#/contacts/%s", name, str(rc["trigger"]), who, c.Name(), company, reply, s.baseURL, url.PathEscape(c.ID))
		channel := str(step["channel"])
		if channel == "" {
			channel = "email"
		}
		var notes []string
		if channel == "email" || channel == "both" {
			to := str(step["email"])
			if to == "" {
				to = s.Account(ctx)
			}
			if to == "" {
				return stepResult{}, errors.New("no address to notify: set the step's e-mail or a default From address")
			}
			subject := str(step["subject"])
			if subject == "" {
				subject = "[Automation] " + name + ": " + who
			}
			if _, err := s.Send(ctx, Outgoing{To: to, Force: true, Subject: subject, Text: summary}); err != nil {
				return stepResult{}, err
			}
			notes = append(notes, "emailed "+to)
		}
		if channel == "whatsapp" || channel == "both" {
			wa := str(step["whatsapp"])
			if wa == "" {
				return stepResult{}, errors.New("enter the WhatsApp number to notify")
			}
			text := summary
			if sub := str(step["subject"]); sub != "" {
				text = sub + "\n" + summary
			}
			if err := s.SendWhatsApp(ctx, wa, WhatsAppOpts{Provider: str(step["provider"]), Text: text}); err != nil {
				return stepResult{}, err
			}
			notes = append(notes, "WhatsApp "+wa)
		}
		return stepResult{note: "notified: " + strings.Join(notes, ", ")}, nil

	case "webhook":
		payload, _ := json.Marshal(map[string]any{"automation": rc["automation_name"], "trigger": rc["trigger"], "event": rc["event"], "contact": c})
		req, err := httpPost(ctx, str(step["url"]), payload)
		if err != nil {
			return stepResult{}, err
		}
		res, err := s.Outbound.Do(req)
		if err != nil {
			return stepResult{}, fmt.Errorf("webhook: %w", err)
		}
		res.Body.Close()
		if res.StatusCode >= 300 {
			return stepResult{}, fmt.Errorf("webhook responded %d", res.StatusCode)
		}
		return stepResult{note: fmt.Sprintf("webhook %d", res.StatusCode)}, nil
	}
	return stepResult{}, fmt.Errorf("unknown step type %s", str(step["type"]))
}

// processRun advances one run until it waits, stops, fails or completes (Automations.processRun).
func (s *Service) processRun(ctx context.Context, run Run, a Automation) error {
	rc := run.Context
	if rc == nil {
		rc = map[string]any{}
	}
	rc["automation_name"] = a.Name
	if str(rc["trigger"]) == "" {
		rc["trigger"] = "manual"
	}
	log := run.Log
	index := run.StepIndex
	save := func(status string, next *time.Time) error {
		if len(log) > 30 {
			log = log[len(log)-30:]
		}
		ctxJSON, _ := json.Marshal(rc)
		logJSON, _ := json.Marshal(log)
		q := `UPDATE runs SET step_index = $2, context = $3::jsonb, log = $4::jsonb, updated_at = $5`
		args := []any{run.ID, index, string(ctxJSON), string(logJSON), s.now()}
		if status != "" {
			q += `, status = $6`
			args = append(args, status)
		} else if next != nil {
			q += `, next_run_at = $6`
			args = append(args, *next)
		}
		// Only an active run moves on: a stop from elsewhere (unsubscribe, reply) wins.
		_, err := s.db.Pool.Exec(ctx, q+` WHERE id = $1 AND status = 'active'`, args...)
		return err
	}
	for guard := 0; guard < 30; guard++ {
		if index >= len(a.Steps) {
			return save("completed", nil)
		}
		step := a.Steps[index]
		run.StepIndex = index
		r, err := s.executeStep(ctx, step, &run, rc)
		entry := map[string]any{"at": s.now().Format(time.RFC3339), "step": index, "type": str(step["type"])}
		if err != nil {
			entry["error"] = err.Error()
			log = append(log, entry)
			return save("failed", nil)
		}
		entry["note"] = r.note
		log = append(log, entry)
		if r.stop {
			return save("stopped", nil)
		}
		if r.waitUntil != nil {
			return save("", r.waitUntil)
		}
		index++
	}
	return save("", nil)
}

// processDue advances every due run of an active automation.
func (s *Service) processDue(ctx context.Context, hasTime func() bool) (int, error) {
	autos, err := s.activeAutomations(ctx)
	if err != nil {
		return 0, err
	}
	byID := map[string]Automation{}
	for _, a := range autos {
		byID[a.ID] = a
	}
	due, err := store.Structs[Run](ctx, s.db.Pool, `SELECT r.* FROM runs r JOIN automations a ON a.id = r.automation_id
		WHERE r.status = 'active' AND r.next_run_at <= $1 AND a.status = 'active' ORDER BY r.next_run_at LIMIT 100`, s.now())
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range due {
		if !hasTime() {
			break
		}
		if err := s.processRun(ctx, r, byID[r.AutomationID]); err != nil {
			s.log.Error("automation run", "run", r.ID, "err", err)
		}
		n++
	}
	return n, nil
}

// Enroll starts the automation for the given contacts and/or every subscribed contact of a list.
func (s *Service) Enroll(ctx context.Context, automationID string, contactIDs []string, listID string) (int, error) {
	a, err := store.Struct[Automation](ctx, s.db.Pool, `SELECT * FROM automations WHERE id = $1`, automationID)
	if err != nil {
		return 0, err
	}
	all := append([]string{}, contactIDs...)
	if listID != "" {
		rows, err := store.Structs[struct {
			ID string `db:"id"`
		}](ctx, s.db.Pool, `SELECT id FROM contacts WHERE $1 = ANY(list_ids) AND status = 'subscribed' ORDER BY created_at`, listID)
		if err != nil {
			return 0, err
		}
		for _, r := range rows {
			all = append(all, r.ID)
		}
	}
	seen := map[string]bool{}
	n := 0
	err = s.db.InTx(ctx, func(tx pgx.Tx) error {
		for _, id := range all {
			if seen[id] {
				continue
			}
			seen[id] = true
			active, err := store.Count(ctx, tx, `SELECT count(*) FROM runs WHERE automation_id = $1 AND contact_id = $2 AND status = 'active'`, a.ID, id)
			if err != nil {
				return err
			}
			if active > 0 {
				continue
			}
			rid, err := s.startRun(ctx, tx, a, id, "manual", Event{ContactID: id})
			if err != nil {
				return err
			}
			if rid != "" {
				n++
			}
		}
		return nil
	})
	if n > 0 {
		s.Wake()
	}
	return n, err
}

func httpPost(ctx context.Context, rawURL string, body []byte) (*http.Request, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("invalid webhook URL %q", rawURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}
