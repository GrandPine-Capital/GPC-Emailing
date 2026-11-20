package app_test

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

var confirmRe = regexp.MustCompile(`https://mail\.test/c\?t=([A-Za-z0-9_.-]+)`)

func mustAutomation(t *testing.T, e *env, doc map[string]any) string {
	t.Helper()
	doc["status"] = "active"
	a, err := e.svc.CreateAutomation(e.ctx, doc)
	if err != nil {
		t.Fatal(err)
	}
	return a["id"].(string)
}

func (e *env) tags(t *testing.T, id string) string {
	t.Helper()
	return e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = $1`, id).(string)
}

func (e *env) status(t *testing.T, id string) string {
	t.Helper()
	return e.scalar(t, `SELECT status FROM contacts WHERE id = $1`, id).(string)
}

// A double opt-in form: the sign-up is pending and unmailed until the link in the confirmation
// e-mail is used; the form's list and tags, and the automations they start, apply then.
func TestDoubleOptInForm(t *testing.T) {
	e := setup(t, true)
	ctx := e.ctx
	list, _ := e.svc.CreateListWith(ctx, "Newsletter", "Monthly news", true)
	listID := list["id"].(string)
	form, err := e.svc.CreateForm(ctx, map[string]any{"name": "Footer form", "fields": []any{"first_name", "bogus"}, "list_ids": []any{listID, "gone"},
		"tags": "newsletter, web", "double_optin": true})
	if err != nil {
		t.Fatal(err)
	}
	formID := form["id"].(string)
	if form["url"] != "https://mail.test/f/"+formID || len(form["fields"].([]any)) != 1 || len(form["list_ids"].([]any)) != 1 {
		t.Fatalf("form = %v", form)
	}
	if _, err := e.svc.CreateForm(ctx, map[string]any{"name": "x", "redirect_url": "javascript:alert(1)"}); err == nil {
		t.Fatal("a redirect that is not a web address must be refused")
	}
	mustAutomation(t, e, map[string]any{"name": "Confirmed", "trigger_type": "subscription_confirmed", "steps": []any{map[string]any{"type": "add_tag", "tag": "confirmed"}}})
	mustAutomation(t, e, map[string]any{"name": "Form", "trigger_type": "form_submitted", "trigger_config": map[string]any{"form_id": formID},
		"steps": []any{map[string]any{"type": "add_tag", "tag": "from-form"}}})
	mustAutomation(t, e, map[string]any{"name": "Joined", "trigger_type": "contact_added", "trigger_config": map[string]any{"list_id": listID},
		"steps": []any{map[string]any{"type": "send_email", "template_id": "std-welcome-email"}}})

	if _, _, err := e.svc.SubmitForm(ctx, formID, map[string]string{"email": "nope"}); err == nil {
		t.Fatal("an invalid address must be refused")
	}
	outcome, _, err := e.svc.SubmitForm(ctx, formID, map[string]string{"email": "Dana@Delta.io", "first_name": "Dana", "company": "not asked for"})
	if err != nil || outcome != "pending" {
		t.Fatalf("submit = %q %v", outcome, err)
	}
	if e.status(t, "dana@delta.io") != "pending" || e.tags(t, "dana@delta.io") != "" {
		t.Fatalf("before confirming: status %s tags %q", e.status(t, "dana@delta.io"), e.tags(t, "dana@delta.io"))
	}
	if e.scalar(t, `SELECT company FROM contacts WHERE id = 'dana@delta.io'`) != "" {
		t.Error("a field the form does not ask for must be ignored")
	}
	e.tick(t)
	if e.ses.count() != 1 {
		t.Fatalf("confirmation e-mails sent: %d", e.ses.count())
	}
	mail := decoded(e.ses.since(0)[0])
	m := confirmRe.FindStringSubmatch(mail)
	if m == nil || !strings.Contains(mail, "Subject: Please confirm your subscription") || !strings.Contains(mail, "Hi Dana") || strings.Contains(mail, "List-Unsubscribe") {
		t.Fatalf("confirmation e-mail:\n%s", mail)
	}
	// Signing up again straight away does not send a second e-mail; nor does another tick.
	if outcome, _, _ := e.svc.SubmitForm(ctx, formID, map[string]string{"email": "dana@delta.io"}); outcome != "pending" {
		t.Fatalf("second submit = %q", outcome)
	}
	e.tick(t)
	if e.ses.count() != 1 {
		t.Fatalf("a repeat sign-up within ten minutes sent %d e-mails", e.ses.count())
	}
	// A pending contact is not a campaign recipient.
	c, _ := e.svc.CreateCampaign(ctx, map[string]any{"name": "N", "template_id": "std-welcome-email", "tags": "newsletter"})
	if c["recipients"] != 0 {
		t.Fatalf("recipients before confirming = %v", c["recipients"])
	}

	if ok, _ := e.svc.Confirm(ctx, m[1]+"x"); ok {
		t.Fatal("a tampered link must not confirm")
	}
	if email, status, ok := e.svc.OptInInfo(ctx, m[1]); !ok || email != "dana@delta.io" || status != "pending" {
		t.Fatalf("opt-in info = %q %q %v", email, status, ok)
	}
	if ok, err := e.svc.Confirm(ctx, m[1]); err != nil || !ok {
		t.Fatalf("confirm = %v %v", ok, err)
	}
	if ok, _ := e.svc.Confirm(ctx, m[1]); !ok {
		t.Fatal("confirming twice is fine")
	}
	e.tick(t)
	e.tick(t)
	tags := e.tags(t, "dana@delta.io")
	for _, want := range []string{"newsletter", "web", "confirmed", "from-form"} {
		if !strings.Contains(tags, want) {
			t.Errorf("tags after confirming = %q, want %s", tags, want)
		}
	}
	if e.status(t, "dana@delta.io") != "subscribed" || e.scalar(t, `SELECT confirmed_at IS NOT NULL AND $1 = ANY(list_ids) FROM contacts WHERE id = 'dana@delta.io'`, listID) != true {
		t.Error("Dana should be subscribed, confirmed and on the list")
	}
	if e.ses.count() != 2 || !strings.Contains(e.ses.since(1)[0], "To: \"Dana\" <dana@delta.io>") {
		t.Fatalf("the welcome automation should have sent one e-mail, total %d", e.ses.count())
	}
	if c, _ := e.svc.Campaign(ctx, c["id"].(string)); c["recipients"] != 1 {
		t.Fatalf("recipients after confirming = %v", c["recipients"])
	}

	// Unsubscribe with a reason; a new sign-up asks to confirm again.
	welcome := decoded(e.ses.since(1)[0])
	tok := regexp.MustCompile(`/u\?t=([a-f0-9]{24})`).FindStringSubmatch(welcome)
	if tok == nil || !strings.Contains(welcome, "https://mail.test/m?t="+tok[1]) {
		t.Fatalf("the e-mail needs unsubscribe and preference links:\n%s", welcome)
	}
	if strings.Contains(welcome, `/r?t=`+tok[1]+`&amp;k=`) && regexp.MustCompile(`href="https://mail\.test/r[^"]*"[^>]*>Manage preferences`).MatchString(welcome) {
		t.Error("the preference link must not be click-tracked")
	}
	if ok, err := e.svc.UnsubscribeWithReason(ctx, tok[1], "I receive too many emails"); err != nil || !ok {
		t.Fatalf("unsubscribe = %v %v", ok, err)
	}
	if e.status(t, "dana@delta.io") != "unsubscribed" || e.scalar(t, `SELECT unsubscribe_reason FROM contacts WHERE id = 'dana@delta.io'`) != "I receive too many emails" {
		t.Error("the unsubscribe reason should be kept")
	}
	e.now = e.now.Add(time.Hour)
	if outcome, _, _ := e.svc.SubmitForm(ctx, formID, map[string]string{"email": "dana@delta.io"}); outcome != "pending" {
		t.Fatalf("re-subscribe = %q", outcome)
	}
	e.tick(t)
	if e.ses.count() != 3 {
		t.Fatalf("the returning subscriber should get a confirmation e-mail, total %d", e.ses.count())
	}
	m = confirmRe.FindStringSubmatch(decoded(e.ses.since(2)[0]))
	if ok, _ := e.svc.Confirm(ctx, m[1]); !ok || e.status(t, "dana@delta.io") != "subscribed" {
		t.Fatal("confirming again should re-subscribe")
	}

	// Someone who complained stays off the list whatever form they fill in.
	if _, err := e.svc.CreateContact(ctx, app.ContactInput{Email: "eve@spam.io", Status: "complained"}); err != nil {
		t.Fatal(err)
	}
	if outcome, _, _ := e.svc.SubmitForm(ctx, formID, map[string]string{"email": "eve@spam.io"}); outcome != "ignored" || e.status(t, "eve@spam.io") != "complained" {
		t.Fatalf("a complainer signing up: %q", outcome)
	}
	if e.scalar(t, `SELECT submissions FROM forms WHERE id = $1`, formID) != int32(4) {
		t.Errorf("submissions = %v", e.scalar(t, `SELECT submissions FROM forms WHERE id = $1`, formID))
	}

	// A single opt-in form subscribes at once.
	single, _ := e.svc.CreateForm(ctx, map[string]any{"name": "Single", "double_optin": false, "tags": []any{"direct"}, "consent_text": "I agree"})
	sid := single["id"].(string)
	if _, _, err := e.svc.SubmitForm(ctx, sid, map[string]string{"email": "finn@fox.io"}); err == nil {
		t.Fatal("the consent box is required")
	}
	if outcome, _, err := e.svc.SubmitForm(ctx, sid, map[string]string{"email": "finn@fox.io", "consent": "yes"}); err != nil || outcome != "subscribed" || e.tags(t, "finn@fox.io") != "direct" {
		t.Fatalf("single opt-in = %q %v", outcome, err)
	}
}

func TestPreferencesAndTags(t *testing.T) {
	e := setup(t, true)
	ctx := e.ctx
	pub, _ := e.svc.CreateListWith(ctx, "News", "", true)
	offers, _ := e.svc.CreateListWith(ctx, "Offers", "", true)
	priv, _ := e.svc.CreateList(ctx, "Internal", "")
	pubID, offersID, privID := pub["id"].(string), offers["id"].(string), priv["id"].(string)
	if _, err := e.svc.CreateContact(ctx, app.ContactInput{Email: "gus@gamma.io", Tags: []string{"vip", "old"}, ListIDs: []string{pubID, privID}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CreateContact(ctx, app.ContactInput{Email: "hal@gamma.io", Tags: []string{"old", "new"}, ListIDs: []string{pubID}}); err != nil {
		t.Fatal(err)
	}
	mustAutomation(t, e, map[string]any{"name": "Left", "trigger_type": "list_removed", "trigger_config": map[string]any{"list_id": pubID},
		"steps": []any{map[string]any{"type": "add_tag", "tag": "left-news"}}})
	mustAutomation(t, e, map[string]any{"name": "Untagged", "trigger_type": "tag_removed", "trigger_config": map[string]any{"tag": "vip"},
		"steps": []any{map[string]any{"type": "add_tag", "tag": "was-vip"}}})

	// Tag audience: everyone tagged old, except those tagged new.
	camp, err := e.svc.CreateCampaign(ctx, map[string]any{"name": "Tagged", "template_id": "std-welcome-email", "tags": []any{"old"}, "exclude_tags": "new"})
	if err != nil || camp["recipients"] != 1 {
		t.Fatalf("recipients = %v %v", camp["recipients"], err)
	}
	if err := e.svc.SendCampaign(ctx, camp["id"].(string)); err != nil {
		t.Fatal(err)
	}
	empty, _ := e.svc.CreateCampaign(ctx, map[string]any{"name": "Nobody", "template_id": "std-welcome-email"})
	if err := e.svc.SendCampaign(ctx, empty["id"].(string)); err == nil {
		t.Fatal("a campaign with no list and no tag must be refused")
	}
	e.tick(t)
	if e.ses.count() != 1 || !strings.Contains(e.ses.since(0)[0], "gus@gamma.io") {
		t.Fatalf("the tagged campaign sent %d", e.ses.count())
	}
	token := e.scalar(t, `SELECT id FROM messages WHERE contact_id = 'gus@gamma.io'`).(string)

	p, err := e.svc.Preferences(ctx, token)
	if err != nil || len(p.Lists) != 2 || !p.Lists[0].Member || p.Lists[1].Member {
		t.Fatalf("preferences = %+v %v", p, err)
	}
	if _, err := e.svc.Preferences(ctx, "test"); !app.IsNotFound(err) {
		t.Fatal("a preview token has no preferences")
	}
	// Leave News, join Offers; the private list is untouched even if its id is posted.
	if err := e.svc.SavePreferences(ctx, token, "Gus", "G", []string{offersID}); err != nil {
		t.Fatal(err)
	}
	lists := e.scalar(t, `SELECT array_to_string(list_ids, ',') FROM contacts WHERE id = 'gus@gamma.io'`).(string)
	if strings.Contains(lists, pubID) || !strings.Contains(lists, offersID) || !strings.Contains(lists, privID) {
		t.Fatalf("lists after saving preferences = %s", lists)
	}
	if subject, html, err := e.svc.ViewOnline(ctx, token); err != nil || subject == "" || strings.Contains(html, "/o?t=") || !strings.Contains(html, "/u?t="+token) {
		t.Fatalf("view online: %q %v", subject, err)
	}

	tags, _ := e.svc.Tags(ctx)
	if len(tags) != 3 || tags[1]["tag"] != "old" || tags[1]["contacts"] != int64(2) {
		t.Fatalf("tags = %v", tags)
	}
	if n, err := e.svc.RenameTag(ctx, "old", "new"); err != nil || n != 2 {
		t.Fatalf("rename = %d %v", n, err)
	}
	if e.tags(t, "hal@gamma.io") != "new" || e.tags(t, "gus@gamma.io") != "vip,new" {
		t.Fatalf("after rename: hal %q gus %q", e.tags(t, "hal@gamma.io"), e.tags(t, "gus@gamma.io"))
	}
	if n, err := e.svc.DeleteTag(ctx, "vip"); err != nil || n != 1 {
		t.Fatalf("delete tag = %d %v", n, err)
	}
	if n, err := e.svc.BulkContacts(ctx, "remove_tag", []string{"hal@gamma.io"}, "new", ""); err != nil || n != 1 || e.tags(t, "hal@gamma.io") != "" {
		t.Fatalf("bulk remove tag = %d %v", n, err)
	}
	e.tick(t)
	got := e.tags(t, "gus@gamma.io")
	if !strings.Contains(got, "left-news") || !strings.Contains(got, "was-vip") {
		t.Fatalf("list_removed and tag_removed automations should have run: %q", got)
	}
}

// The logic steps: only-continue-if, wait-until goals, and starting / stopping other automations.
func TestAutomationLogicSteps(t *testing.T) {
	e := setup(t, false)
	ctx := e.ctx
	for _, c := range []app.ContactInput{{Email: "ivy@i.io", Tags: []string{"vip"}}, {Email: "jon@j.io"}} {
		if _, err := e.svc.CreateContact(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	other := mustAutomation(t, e, map[string]any{"name": "Other", "trigger_type": "manual", "steps": []any{
		map[string]any{"type": "add_tag", "tag": "in-other"}, map[string]any{"type": "wait", "amount": 30, "unit": "days"}}})
	for _, bad := range []map[string]any{
		{"type": "if_else"}, {"type": "if_else", "condition": "has_tag"}, {"type": "wait_until", "condition": "in_list"}, {"type": "start_automation"},
	} {
		if _, err := e.svc.CreateAutomation(ctx, map[string]any{"trigger_type": "manual", "steps": []any{bad}}); err == nil {
			t.Fatalf("step %v must be refused", bad)
		}
	}
	main := mustAutomation(t, e, map[string]any{"name": "Main", "trigger_type": "manual", "steps": []any{
		map[string]any{"type": "if_else", "condition": "has_tag", "tag": "vip", "skip": 1},
		map[string]any{"type": "add_tag", "tag": "vip-path"},
		map[string]any{"type": "start_automation", "automation_id": other},
		map[string]any{"type": "wait_until", "condition": "has_tag", "tag": "bought", "amount": 2, "unit": "days", "on_timeout": "stop"},
		map[string]any{"type": "stop_automation", "automation_id": ""},
		map[string]any{"type": "add_tag", "tag": "goal"},
	}})
	if n, err := e.svc.Enroll(ctx, main, []string{"ivy@i.io", "jon@j.io"}, ""); err != nil || n != 2 {
		t.Fatalf("enroll %d %v", n, err)
	}
	e.tick(t)
	e.tick(t)
	if got := e.tags(t, "ivy@i.io"); got != "vip,vip-path,in-other" {
		t.Fatalf("Ivy has the tag, so nothing is skipped: %q", got)
	}
	if got := e.tags(t, "jon@j.io"); got != "in-other" {
		t.Fatalf("Jon lacks the tag, so the next step is skipped: %q", got)
	}
	// Ivy reaches the goal after a day; Jon never does and is dropped at the time limit.
	e.now = e.now.Add(24 * time.Hour)
	if _, err := e.svc.BulkContacts(ctx, "add_tag", []string{"ivy@i.io"}, "bought", ""); err != nil {
		t.Fatal(err)
	}
	e.tick(t)
	if got := e.tags(t, "ivy@i.io"); !strings.HasSuffix(got, "bought,goal") {
		t.Fatalf("Ivy reached the goal: %q", got)
	}
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1 AND contact_id = 'ivy@i.io'`, other) != "stopped" {
		t.Error("reaching the goal should stop Ivy's other automation")
	}
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1 AND contact_id = 'jon@j.io'`, main) != "active" {
		t.Error("Jon is still waiting for the goal")
	}
	e.now = e.now.Add(25 * time.Hour)
	e.tick(t)
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1 AND contact_id = 'jon@j.io'`, main) != "stopped" || strings.Contains(e.tags(t, "jon@j.io"), "goal") {
		t.Error("Jon should be dropped when the time limit passes")
	}
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1 AND contact_id = 'jon@j.io'`, other) != "active" {
		t.Error("Jon's other automation carries on")
	}
}
