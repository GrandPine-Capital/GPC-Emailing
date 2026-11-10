package app_test

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/ses"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

// fakeSES stands in for Amazon SES: it keeps what was sent and serves the events and inbound
// queues.
type fakeSES struct {
	mu      sync.Mutex
	sent    []string
	events  []ses.Event
	inbound [][2]string // id, raw
}

func (f *fakeSES) Region() string { return "ap-southeast-5" }
func (f *fakeSES) Send(_ context.Context, raw []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, string(raw))
	return fmt.Sprintf("ses-%d", len(f.sent)), nil
}
func (f *fakeSES) Remaining(context.Context) (int, error) { return 1000, nil }
func (f *fakeSES) Account(context.Context) (ses.Account, error) {
	return ses.Account{Production: true}, nil
}
func (f *fakeSES) Identities(context.Context) ([]ses.Identity, error) {
	return []ses.Identity{{Email: "grandpine.test", Type: "domain", Verified: true}, {Email: "other.test", Type: "domain", Verified: false}}, nil
}
func (f *fakeSES) PollEvents(_ context.Context, fn func(ses.Event) error) (int, error) {
	f.mu.Lock()
	evs := f.events
	f.events = nil
	f.mu.Unlock()
	for _, e := range evs {
		if err := fn(e); err != nil {
			return 0, err
		}
	}
	return len(evs), nil
}
func (f *fakeSES) PollInbound(_ context.Context, fn func(string, []byte) error) (int, error) {
	f.mu.Lock()
	in := f.inbound
	f.inbound = nil
	f.mu.Unlock()
	for _, m := range in {
		if err := fn(m[0], []byte(m[1])); err != nil {
			return 0, err
		}
	}
	return len(in), nil
}

func (f *fakeSES) receive(id string, headers map[string]string, body string) {
	var b strings.Builder
	for k, v := range headers {
		b.WriteString(k + ": " + v + "\r\n")
	}
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n" + body)
	f.mu.Lock()
	f.inbound = append(f.inbound, [2]string{id, b.String()})
	f.mu.Unlock()
}

func (f *fakeSES) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

// since returns the messages sent after the first n.
func (f *fakeSES) since(n int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.sent[n:]...)
}

// decoded is a sent message with its base64 parts decoded.
func decoded(raw string) string {
	out := raw
	for _, m := range regexp.MustCompile(`(?s)Content-Transfer-Encoding: base64\r\n\r\n(.*?)\r\n--`).FindAllStringSubmatch(raw, -1) {
		b, _ := base64.StdEncoding.DecodeString(strings.ReplaceAll(m[1], "\r\n", ""))
		out += "\n" + string(b)
	}
	return out
}

type env struct {
	svc *app.Service
	db  *store.DB
	ses *fakeSES
	now time.Time
	ctx context.Context
}

var mailCfg = app.MailConfig{DefaultFrom: "hello@grandpine.test", ReplyDomain: "reply.grandpine.test"}

func setup(t *testing.T, withMail bool) *env {
	db, box, key := testdb.New(t)
	e := &env{db: db, ses: &fakeSES{}, now: time.Date(2026, 11, 10, 2, 0, 0, 0, time.UTC), ctx: context.Background()}
	var mail app.Mail
	if withMail {
		mail = e.ses
	}
	e.svc = app.New(db, box, key, "https://mail.test", mail, mailCfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.svc.Now = func() time.Time { return e.now }
	return e
}

func (e *env) tick(t *testing.T) map[string]any {
	t.Helper()
	s, err := e.svc.Tick(e.ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range s {
		if str, ok := v.(string); ok && strings.HasPrefix(str, "error") {
			t.Fatalf("tick %s: %s", k, str)
		}
	}
	return s
}

func (e *env) scalar(t *testing.T, sql string, args ...any) any {
	t.Helper()
	var v any
	if err := e.db.Pool.QueryRow(e.ctx, sql, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return v
}

var (
	pixelRe = regexp.MustCompile(`https://mail\.test/o\?t=([a-f0-9]{24})`)
	clickRe = regexp.MustCompile(`https://mail\.test/r\?t=([a-f0-9]{24})&amp;k=([a-f0-9]{24})`)
)

func TestCampaignLifecycle(t *testing.T) {
	e := setup(t, true)
	ctx := e.ctx
	list, err := e.svc.CreateList(ctx, "Prospects", "")
	if err != nil {
		t.Fatal(err)
	}
	listID := list["id"].(string)
	res, err := e.svc.ImportContacts(ctx, []map[string]string{
		{"email": "Alice@Acme.com", "first_name": "Alice", "company": "Acme"},
		{"email": "bob@beta.io", "first_name": "Bob", "tags": "vip"},
		{"email": "carol@gamma.io", "first_name": "Carol"},
		{"email": "not-an-email"},
	}, listID, []string{"import"}, "Malaysia", "")
	if err != nil {
		t.Fatal(err)
	}
	if res["created"] != 3 || res["skipped"] != 1 {
		t.Fatalf("import = %v", res)
	}
	// The seeded "Hot lead" automation, switched on: a reply mentioning pricing tags the contact
	// and notifies the team.
	if err := e.svc.SetAutomationStatus(ctx, "std-hot-lead", "active"); err != nil {
		t.Fatal(err)
	}

	camp, err := e.svc.CreateCampaign(ctx, map[string]any{"name": "Launch", "subject": "Hi {{first_name|there}}", "template_id": "std-welcome-email",
		"list_ids": []any{listID}, "from_email": "sales@grandpine.test", "from_name": "Sales", "preheader": "Big news"})
	if err != nil {
		t.Fatal(err)
	}
	campID := camp["id"].(string)
	if err := e.svc.SendCampaign(ctx, campID); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SendCampaign(ctx, campID); err == nil {
		t.Fatal("sending a launching campaign twice must be refused")
	}
	e.tick(t)
	if e.ses.count() != 3 {
		t.Fatalf("sent %d e-mails, want 3", e.ses.count())
	}
	c, _ := e.svc.Campaign(ctx, campID)
	st := c["stats"].(map[string]any)
	if c["status"] != "sent" || int(st["sent"].(float64)) != 3 || int(st["queued"].(float64)) != 0 {
		t.Fatalf("campaign after send: status %v stats %v", c["status"], st)
	}

	// A sender on an unverified domain fails per message, not the whole run.
	bad, _ := e.svc.CreateCampaign(ctx, map[string]any{"name": "Bad", "template_id": "std-welcome-email", "list_ids": []any{listID}, "from_email": "x@other.test"})
	if err := e.svc.SendCampaign(ctx, bad["id"].(string)); err != nil {
		t.Fatal(err)
	}
	e.tick(t)
	if n := e.scalar(t, `SELECT count(*) FROM messages WHERE campaign_id = $1 AND status = 'failed' AND error LIKE '%not a verified SES sender%'`, bad["id"]); n.(int64) != 3 {
		t.Errorf("unverified sender: %v failed messages", n)
	}

	var alice string
	for _, m := range e.ses.since(0) {
		if strings.Contains(m, "<alice@acme.com>") {
			alice = decoded(m)
		}
	}
	for _, want := range []string{`From: "Sales" <sales@grandpine.test>`, "Reply-To: sales@reply.grandpine.test", "Subject: Hi Alice",
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click", "<mailto:unsubscribe@reply.grandpine.test?subject=unsubscribe%20", "https://mail.test/u1?t=",
		"Big news", "https://mail.test/u?t="} {
		if !strings.Contains(alice, want) {
			t.Errorf("Alice's e-mail lacks %q", want)
		}
	}
	token := pixelRe.FindStringSubmatch(alice)
	if token == nil {
		t.Fatal("no open pixel")
	}
	_ = e.svc.Open(ctx, token[1])
	_ = e.svc.Open(ctx, token[1]) // a second open counts on the message, not the campaign
	click := clickRe.FindStringSubmatch(alice)
	if click == nil || click[1] != token[1] {
		t.Fatal("no tracked link")
	}
	if target, err := e.svc.Click(ctx, click[1], click[2]); err != nil || !strings.HasPrefix(target, "https://example.com") {
		t.Fatalf("click → %q, %v", target, err)
	}
	if u, _ := e.svc.Click(ctx, click[1], "000000000000000000000000"); u != "" {
		t.Fatal("an unknown link key must not redirect")
	}
	c, _ = e.svc.Campaign(ctx, campID)
	st = c["stats"].(map[string]any)
	if st["opened"].(float64) != 1 || st["clicked"].(float64) != 1 {
		t.Fatalf("stats after open+click: %v", st)
	}

	// Alice replies to the reply domain, naming the message she answers; Bob's address bounces;
	// Carol marks the mail as spam.
	rfc := e.scalar(t, `SELECT rfc_message_id FROM messages WHERE id = $1`, token[1]).(string)
	if !strings.HasSuffix(rfc, "@ap-southeast-5.amazonses.com>") {
		t.Errorf("rfc_message_id %q", rfc)
	}
	e.now = e.now.Add(10 * time.Minute)
	e.ses.receive("in-1", map[string]string{"From": "Alice Tan <alice@acme.com>", "To": "sales@reply.grandpine.test", "Subject": "Re: Hi Alice",
		"Message-ID": "<r1@acme.com>", "In-Reply-To": rfc, "Date": e.now.Format(time.RFC1123Z)}, "What is your pricing?\r\n\r\nOn Mon, Sales wrote:\r\n> Hi")
	var bobMsg, carolMsg string
	_ = e.db.Pool.QueryRow(ctx, `SELECT provider_id FROM messages WHERE contact_id = 'bob@beta.io' AND campaign_id = $1`, campID).Scan(&bobMsg)
	_ = e.db.Pool.QueryRow(ctx, `SELECT provider_id FROM messages WHERE contact_id = 'carol@gamma.io' AND campaign_id = $1`, campID).Scan(&carolMsg)
	e.ses.events = []ses.Event{
		{Type: "Bounce", Permanent: true, MessageID: bobMsg, Recipients: []string{"bob@beta.io"}},
		{Type: "Complaint", MessageID: carolMsg, Recipients: []string{"carol@gamma.io"}},
	}
	before := e.ses.count()
	e.tick(t)
	e.tick(t) // the automation run started by the reply advances on the next tick
	replies, _ := e.svc.Replies(ctx)
	if len(replies) != 1 || replies[0]["body"] != "What is your pricing?" || replies[0]["campaign_id"] != campID {
		t.Fatalf("replies = %v", replies)
	}
	if e.scalar(t, `SELECT status FROM contacts WHERE id = 'bob@beta.io'`) != "bounced" {
		t.Error("Bob should be bounced")
	}
	if e.scalar(t, `SELECT status FROM contacts WHERE id = 'carol@gamma.io'`) != "unsubscribed" {
		t.Error("Carol complained: she should be unsubscribed")
	}
	if tags := e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'alice@acme.com'`); !strings.Contains(tags.(string), "hot-lead") {
		t.Errorf("Alice's tags = %v", tags)
	}
	var forward, notify string
	for _, m := range e.ses.since(before) {
		switch {
		case strings.Contains(m, "Subject: Fwd: Re: Hi Alice"):
			forward = m
		case strings.Contains(m, "Subject: Hot lead replied!"):
			notify = m
		}
	}
	if forward == "" || !strings.Contains(forward, "To: sales@grandpine.test") || !strings.Contains(forward, "Reply-To: alice@acme.com") ||
		!strings.Contains(forward, "Content-Type: message/rfc822") || !strings.Contains(forward, "X-GPC-Emailing-Forwarded: 1") {
		t.Errorf("the reply must be forwarded to sales@grandpine.test:\n%s", forward)
	}
	if notify == "" {
		t.Error("expected the team notification")
	}
	c, _ = e.svc.Campaign(ctx, campID)
	if st := c["stats"].(map[string]any); st["replied"].(float64) != 1 || st["unsubscribed"].(float64) != 1 {
		t.Errorf("campaign stats %v", st)
	}
	// SQS delivers at least once: the same e-mail again changes nothing, and our own forward
	// coming back (a mailbox rule) is ignored.
	e.ses.receive("in-1", map[string]string{"From": "alice@acme.com", "To": "sales@reply.grandpine.test", "Subject": "Re: Hi Alice", "In-Reply-To": rfc}, "again")
	e.ses.receive("in-2", map[string]string{"From": "sales@grandpine.test", "To": "sales@reply.grandpine.test", "Subject": "Fwd: x", "X-GPC-Emailing-Forwarded": "1"}, "loop")
	n := e.ses.count()
	e.tick(t)
	if r := e.scalar(t, `SELECT count(*) FROM replies`); r.(int64) != 1 || e.ses.count() != n {
		t.Errorf("replies %v, sent %d more", r, e.ses.count()-n)
	}

	if ok, err := e.svc.Unsubscribe(ctx, token[1]); err != nil || !ok {
		t.Fatalf("unsubscribe: %v %v", ok, err)
	}
	if ok, _ := e.svc.Unsubscribe(ctx, token[1]); ok {
		t.Error("a second unsubscribe must be a no-op")
	}
}

func TestFollowUpRepliesToTheFirstEmail(t *testing.T) {
	e := setup(t, true)
	ctx := e.ctx
	if _, err := e.svc.CreateContact(ctx, app.ContactInput{Email: "carol@gamma.co", FirstName: "Carol"}); err != nil {
		t.Fatal(err)
	}
	// Welcome (manual) sends the first e-mail; Follow-up starts on that email_sent event and
	// answers it two days later unless Carol replied.
	welcome, err := e.svc.CreateAutomation(ctx, map[string]any{"name": "Welcome", "trigger_type": "manual", "status": "active", "steps": []any{
		map[string]any{"type": "send_email", "template_id": "std-welcome-email"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	a, err := e.svc.CreateAutomation(ctx, map[string]any{"name": "Follow-up", "trigger_type": "email_sent", "status": "active",
		"trigger_config": map[string]any{"template_id": "std-welcome-email", "stop_on_reply": true}, "steps": []any{
			map[string]any{"type": "wait", "amount": 2, "unit": "days"},
			map[string]any{"type": "stop_if", "condition": "replied"},
			map[string]any{"type": "send_email", "template_id": "std-personal-follow-up-plain", "reply_in_thread": true},
			map[string]any{"type": "add_tag", "tag": "nurtured"},
		}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CreateAutomation(ctx, map[string]any{"trigger_type": "manual", "steps": []any{map[string]any{"type": "send_email"}}}); err == nil {
		t.Fatal("a send_email step without a template must be refused")
	}
	wid := welcome["id"].(string)
	if n, err := e.svc.Enroll(ctx, wid, []string{"carol@gamma.co"}, ""); err != nil || n != 1 {
		t.Fatalf("enroll %d %v", n, err)
	}
	if n, _ := e.svc.Enroll(ctx, wid, []string{"carol@gamma.co"}, ""); n != 0 {
		t.Fatal("an active run must not be enrolled twice")
	}
	e.tick(t)
	e.tick(t) // the follow-up run, started by that e-mail, begins its two-day wait
	if e.ses.count() != 1 {
		t.Fatalf("first step sent %d", e.ses.count())
	}
	e.now = e.now.Add(24 * time.Hour)
	e.tick(t)
	if e.ses.count() != 1 {
		t.Fatal("the wait step must hold the run")
	}
	e.now = e.now.Add(25 * time.Hour)
	e.tick(t)
	if e.ses.count() != 2 {
		t.Fatalf("after the wait: sent %d", e.ses.count())
	}
	follow := e.ses.since(1)[0]
	if !strings.Contains(follow, "In-Reply-To: <ses-1@ap-southeast-5.amazonses.com>") || !strings.Contains(follow, "Subject: Re: ") {
		t.Errorf("the follow-up must answer the first e-mail:\n%s", follow[:min(600, len(follow))])
	}
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1`, a["id"]) != "completed" {
		t.Error("run should be completed")
	}
	if !strings.Contains(e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'carol@gamma.co'`).(string), "nurtured") {
		t.Error("the last step should tag Carol")
	}
}

func TestAutoReplyAndWebhooks(t *testing.T) {
	e := setup(t, true)
	ctx := e.ctx
	if _, err := e.svc.CreateAutoReply(ctx, map[string]any{"name": "Enquiries", "enabled": true, "template_id": "std-thank-you-for-your-reply-auto-response",
		"audience": "all", "to_address": "hello@grandpine.test", "create_contact": true, "tags": "inbound", "timezone": "Asia/Kuala_Lumpur"}); err != nil {
		t.Fatal(err)
	}
	e.ses.receive("m1", map[string]string{"From": "Dan Lee <dan@delta.com>", "To": "hello@reply.grandpine.test", "Subject": "Question", "Message-ID": "<q@delta>"}, "Hello")
	e.ses.receive("m2", map[string]string{"From": "news@shop.com", "To": "hello@reply.grandpine.test", "Subject": "Sale", "List-Unsubscribe": "<mailto:x>"}, "Buy")
	e.tick(t)
	var auto string
	for _, m := range e.ses.since(0) {
		if strings.Contains(m, "Auto-Submitted: auto-replied") {
			auto = m
		}
	}
	if auto == "" || !strings.Contains(auto, `To: "Dan Lee" <dan@delta.com>`) || !strings.Contains(auto, `From: "My Company" <hello@grandpine.test>`) ||
		!strings.Contains(auto, "In-Reply-To: <q@delta>") {
		t.Fatalf("auto-reply:\n%s", auto)
	}
	if strings.Contains(decoded(auto), "/o?t=") {
		t.Error("auto-replies are not tracked")
	}
	rows, _ := e.svc.Inbound(ctx, 10)
	got := map[string]string{}
	for _, r := range rows {
		got[r["from_email"].(string)] = r["status"].(string)
	}
	if got["dan@delta.com"] != "replied" || got["news@shop.com"] != "skipped" {
		t.Errorf("inbound = %v", got)
	}
	if e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'dan@delta.com'`) != "inbound" {
		t.Error("the rule should create the contact with its tag")
	}
	// Cool-down: the same sender again within 24 hours gets no second auto-reply.
	n := e.ses.count()
	e.ses.receive("m3", map[string]string{"From": "dan@delta.com", "To": "hello@reply.grandpine.test", "Subject": "Again"}, "Hi")
	e.tick(t)
	for _, m := range e.ses.since(n) {
		if strings.Contains(m, "Auto-Submitted: auto-replied") {
			t.Error("cool-down ignored")
		}
	}

	secret, err := e.svc.WebhookSecret(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.HandleWebhook(ctx, map[string]string{"k": "wrong"}, []byte(`{}`)); err != app.ErrBadWebhookKey {
		t.Fatalf("bad key: %v", err)
	}
	out, err := e.svc.HandleWebhook(ctx, map[string]string{"k": secret, "event": "form"}, []byte(`{"email":"Eve@Epsilon.io","name":"Eve Ong","phone":"012-345 6789","tags":["webinar"]}`))
	if err != nil || out["contact"] != "eve@epsilon.io" {
		t.Fatalf("generic webhook: %v %v", out, err)
	}
	out, err = e.svc.HandleWebhook(ctx, map[string]string{"k": secret, "src": "chatdaddy"}, []byte(`{"event":"message-insert","data":[
		{"id":"wa1","chatId":"60123456789@s.whatsapp.net","text":"Hi from WhatsApp","sender":{"name":"Eve"}},
		{"id":"wa2","chatId":"123@g.us","text":"group"},{"id":"wa3","fromMe":true,"chatId":"601"}]}`))
	if err != nil || out["handled"] != 1 {
		t.Fatalf("chatdaddy webhook: %v %v", out, err)
	}
	if n := e.scalar(t, `SELECT count(*) FROM replies WHERE channel = 'whatsapp'`); n.(int64) != 1 {
		t.Errorf("whatsapp replies = %v", n)
	}
}

func TestNothingFailsWithoutSES(t *testing.T) {
	e := setup(t, false)
	ctx := e.ctx
	list, _ := e.svc.CreateList(ctx, "L", "")
	if _, err := e.svc.UpsertContacts(ctx, []app.ContactInput{{Email: "x@y.com"}}, []string{list["id"].(string)}, nil, "manual", false); err != nil {
		t.Fatal(err)
	}
	camp, _ := e.svc.CreateCampaign(ctx, map[string]any{"name": "C", "template_id": "std-welcome-email", "list_ids": []any{list["id"]}})
	if err := e.svc.SendCampaign(ctx, camp["id"].(string)); err != nil {
		t.Fatal(err)
	}
	s, err := e.svc.Tick(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if s["campaigns"] != "sending not set up" {
		t.Errorf("summary = %v", s)
	}
	if e.scalar(t, `SELECT status FROM messages`) != "queued" {
		t.Error("mail must wait for SES, not fail")
	}
	// Dry-run mode records the send without SES.
	if err := e.svc.UpdateSettings(ctx, map[string]any{"dry_run": true}); err != nil {
		t.Fatal(err)
	}
	e.tick(t)
	if e.scalar(t, `SELECT status FROM messages`) != "sent" || e.scalar(t, `SELECT dry_run FROM messages`) != true {
		t.Error("dry run should mark the message sent")
	}
}
