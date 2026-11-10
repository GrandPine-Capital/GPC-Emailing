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
	"github.com/grandpine-capital/gpc-emailing/internal/gmail"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

// fakeMailbox stands in for Gmail: it keeps what was sent and serves an inbox.
type fakeMailbox struct {
	mu    sync.Mutex
	sent  []sentMail
	inbox []*gmail.Message
	n     int
}

type sentMail struct {
	Raw, Thread string
}

func (f *fakeMailbox) Send(_ context.Context, raw []byte, thread string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	f.sent = append(f.sent, sentMail{string(raw), thread})
	if thread == "" {
		thread = fmt.Sprintf("thread-%d", f.n)
	}
	return fmt.Sprintf("gm-%d", f.n), thread, nil
}
func (f *fakeMailbox) MessageIDHeader(_ context.Context, id string) (string, error) {
	return "<" + id + "@mail.gmail.com>", nil
}
func (f *fakeMailbox) List(context.Context, string, int) ([]gmail.Ref, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []gmail.Ref
	for i := len(f.inbox) - 1; i >= 0; i-- { // newest first, as Gmail answers
		out = append(out, gmail.Ref{ID: f.inbox[i].ID, ThreadID: f.inbox[i].ThreadID})
	}
	return out, nil
}
func (f *fakeMailbox) Get(_ context.Context, id string) (*gmail.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.inbox {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, fmt.Errorf("no message %s", id)
}
func (f *fakeMailbox) SendAsList(context.Context) ([]gmail.SendAs, error) {
	return []gmail.SendAs{{Email: "worker@example.com", Primary: true, Verified: true}, {Email: "sales@example.com", Name: "Sales", Verified: true}}, nil
}

func (f *fakeMailbox) last() sentMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[len(f.sent)-1]
}
func (f *fakeMailbox) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
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
	mb  *fakeMailbox
	now time.Time
	ctx context.Context
}

func setup(t *testing.T) *env {
	db, box, key := testdb.New(t)
	svc := app.New(db, box, key, "https://mail.test", &gmail.OAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e := &env{svc: svc, db: db, mb: &fakeMailbox{}, now: time.Date(2026, 11, 10, 2, 0, 0, 0, time.UTC), ctx: context.Background()}
	svc.MailboxOverride = e.mb
	svc.Now = func() time.Time { return e.now }
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
	e := setup(t)
	ctx := e.ctx
	if _, err := e.svc.RefreshSenders(ctx); err != nil {
		t.Fatal(err)
	}
	list, err := e.svc.CreateList(ctx, "Prospects", "")
	if err != nil {
		t.Fatal(err)
	}
	listID := list["id"].(string)
	res, err := e.svc.ImportContacts(ctx, []map[string]string{
		{"email": "Alice@Acme.com", "first_name": "Alice", "company": "Acme"},
		{"email": "bob@beta.io", "first_name": "Bob", "tags": "vip"},
		{"email": "not-an-email"},
	}, listID, []string{"import"}, "Malaysia", "")
	if err != nil {
		t.Fatal(err)
	}
	if res["created"] != 2 || res["skipped"] != 1 {
		t.Fatalf("import = %v", res)
	}

	// The seeded "Hot lead" automation, switched on: a reply mentioning pricing tags the contact
	// and notifies the team.
	if err := e.svc.SetAutomationStatus(ctx, "std-hot-lead", "active"); err != nil {
		t.Fatal(err)
	}

	camp, err := e.svc.CreateCampaign(ctx, map[string]any{"name": "Launch", "subject": "Hi {{first_name|there}}", "template_id": "std-welcome-email",
		"list_ids": []any{listID}, "from_email": "sales@example.com", "preheader": "Big news"})
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
	if e.mb.count() != 2 {
		t.Fatalf("sent %d e-mails, want 2", e.mb.count())
	}
	c, err := e.svc.Campaign(ctx, campID)
	if err != nil {
		t.Fatal(err)
	}
	st := c["stats"].(map[string]any)
	if c["status"] != "sent" || int(st["sent"].(float64)) != 2 || int(st["queued"].(float64)) != 0 {
		t.Fatalf("campaign after send: status %v stats %v", c["status"], st)
	}

	var alice string
	for _, m := range e.mb.sent {
		if strings.Contains(m.Raw, "<alice@acme.com>") {
			alice = decoded(m.Raw)
		}
	}
	for _, want := range []string{"From: \"Sales\" <sales@example.com>", "Subject: Hi Alice", "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
		"https://mail.test/u1?t=", "Big news", "https://mail.test/u?t="} {
		if !strings.Contains(alice, want) {
			t.Errorf("Alice's e-mail lacks %q", want)
		}
	}
	token := pixelRe.FindStringSubmatch(alice)
	if token == nil {
		t.Fatal("no open pixel")
	}
	if err := e.svc.Open(ctx, token[1]); err != nil {
		t.Fatal(err)
	}
	_ = e.svc.Open(ctx, token[1]) // a second open counts on the message, not the campaign
	click := clickRe.FindStringSubmatch(alice)
	if click == nil || click[1] != token[1] {
		t.Fatal("no tracked link")
	}
	target, err := e.svc.Click(ctx, click[1], click[2])
	if err != nil || !strings.HasPrefix(target, "https://example.com") {
		t.Fatalf("click → %q, %v", target, err)
	}
	if u, _ := e.svc.Click(ctx, click[1], "000000000000000000000000"); u != "" {
		t.Fatal("an unknown link key must not redirect")
	}
	c, _ = e.svc.Campaign(ctx, campID)
	st = c["stats"].(map[string]any)
	if st["opened"].(float64) != 1 || st["clicked"].(float64) != 1 || st["open_rate"].(float64) != 50 {
		t.Fatalf("stats after open+click: %v", st)
	}
	if n := e.scalar(t, `SELECT open_count FROM messages WHERE id = $1`, token[1]); n.(int32) != 2 {
		t.Fatalf("open_count = %v", n)
	}

	// Alice replies in the thread, mentioning pricing.
	var thread string
	_ = e.db.Pool.QueryRow(ctx, `SELECT thread_id FROM messages WHERE id = $1`, token[1]).Scan(&thread)
	e.now = e.now.Add(10 * time.Minute)
	e.mb.inbox = append(e.mb.inbox, gmail.NewMessage("in-1", thread, e.now, map[string]string{
		"From": "Alice Tan <alice@acme.com>", "To": "sales@example.com", "Subject": "Re: Hi Alice", "Message-ID": "<r1@acme.com>",
	}, "What is your pricing?\n\nOn Mon, Sales wrote:\n> Hi"))
	// A bounce for Bob.
	e.mb.inbox = append(e.mb.inbox, gmail.NewMessage("in-2", "t-b", e.now, map[string]string{
		"From": "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Subject": "Delivery Status Notification (Failure)",
	}, "Final-Recipient: rfc822; bob@beta.io\nAction: failed"))
	before := e.mb.count()
	e.tick(t)
	e.tick(t) // the automation run started by the reply advances on the next tick
	replies, _ := e.svc.Replies(ctx)
	if len(replies) != 1 || replies[0]["body"] != "What is your pricing?" || replies[0]["campaign_id"] != campID {
		t.Fatalf("replies = %v", replies)
	}
	if e.scalar(t, `SELECT status FROM contacts WHERE id = 'bob@beta.io'`) != "bounced" {
		t.Error("Bob should be bounced")
	}
	if tags := e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'alice@acme.com'`); !strings.Contains(tags.(string), "hot-lead") {
		t.Errorf("Alice's tags = %v", tags)
	}
	if e.mb.count() != before+1 || !strings.Contains(e.mb.last().Raw, "Subject: Hot lead replied!") {
		t.Errorf("expected the team notification, sent %d", e.mb.count()-before)
	}
	c, _ = e.svc.Campaign(ctx, campID)
	if c["stats"].(map[string]any)["replied"].(float64) != 1 {
		t.Error("campaign replied count")
	}
	// The same inbox again changes nothing.
	e.tick(t)
	if n := e.scalar(t, `SELECT count(*) FROM replies`); n.(int64) != 1 {
		t.Errorf("replies after re-poll = %v", n)
	}

	// Unsubscribe through the link.
	if ok, err := e.svc.Unsubscribe(ctx, token[1]); err != nil || !ok {
		t.Fatalf("unsubscribe: %v %v", ok, err)
	}
	if ok, _ := e.svc.Unsubscribe(ctx, token[1]); ok {
		t.Error("a second unsubscribe must be a no-op")
	}
	c, _ = e.svc.Campaign(ctx, campID)
	if c["stats"].(map[string]any)["unsubscribed"].(float64) != 1 {
		t.Error("campaign unsubscribed count")
	}
}

func TestFollowUpSequenceWaitsAndStopsOnReply(t *testing.T) {
	e := setup(t)
	ctx := e.ctx
	if _, err := e.svc.CreateContact(ctx, app.ContactInput{Email: "carol@gamma.co", FirstName: "Carol"}); err != nil {
		t.Fatal(err)
	}
	// Welcome (manual) sends the first e-mail; Follow-up starts on that e-mail_sent event and
	// replies in its thread two days later unless Carol replied.
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
	id := a["id"].(string)
	wid := welcome["id"].(string)
	if n, err := e.svc.Enroll(ctx, wid, []string{"carol@gamma.co"}, ""); err != nil || n != 1 {
		t.Fatalf("enroll %d %v", n, err)
	}
	if n, _ := e.svc.Enroll(ctx, wid, []string{"carol@gamma.co"}, ""); n != 0 {
		t.Fatal("an active run must not be enrolled twice")
	}
	e.tick(t)
	if e.mb.count() != 1 {
		t.Fatalf("first step sent %d", e.mb.count())
	}
	e.tick(t) // the follow-up run, started by that e-mail, begins its two-day wait
	e.now = e.now.Add(24 * time.Hour)
	e.tick(t)
	if e.mb.count() != 1 {
		t.Fatal("the wait step must hold the run")
	}
	e.now = e.now.Add(25 * time.Hour)
	e.tick(t)
	if e.mb.count() != 2 {
		t.Fatalf("after the wait: sent %d", e.mb.count())
	}
	follow := e.mb.last()
	if follow.Thread != "thread-1" || !strings.Contains(follow.Raw, "In-Reply-To: <gm-1@mail.gmail.com>") || !strings.Contains(follow.Raw, "Subject: Re: ") {
		t.Errorf("the follow-up must reply in the thread: thread %q", follow.Thread)
	}
	if e.scalar(t, `SELECT status FROM runs WHERE automation_id = $1`, id) != "completed" {
		t.Error("run should be completed")
	}
	auto, _ := e.svc.Automation(ctx, id)
	if auto["runs"].(map[string]any)["completed"].(float64) != 1 {
		t.Errorf("runs = %v", auto["runs"])
	}
	if !strings.Contains(e.scalar(t, `SELECT array_to_string(tags, ',') FROM contacts WHERE id = 'carol@gamma.co'`).(string), "nurtured") {
		t.Error("the last step should tag Carol")
	}
}

func TestAutoReplyAndWebhooks(t *testing.T) {
	e := setup(t)
	ctx := e.ctx
	if _, err := e.svc.CreateAutoReply(ctx, map[string]any{"name": "Out of hours", "enabled": true, "template_id": "std-thank-you-for-your-reply-auto-response",
		"audience": "all", "create_contact": true, "tags": "inbound", "timezone": "Asia/Kuala_Lumpur"}); err != nil {
		t.Fatal(err)
	}
	e.mb.inbox = []*gmail.Message{
		gmail.NewMessage("m1", "t1", e.now, map[string]string{"From": "Dan Lee <dan@delta.com>", "To": "worker@example.com", "Subject": "Question", "Message-ID": "<q@delta>"}, "Hello"),
		gmail.NewMessage("m2", "t2", e.now, map[string]string{"From": "news@shop.com", "To": "worker@example.com", "Subject": "Sale", "List-Unsubscribe": "<mailto:x>"}, "Buy"),
	}
	e.tick(t)
	if e.mb.count() != 1 || !strings.Contains(e.mb.last().Raw, "Auto-Submitted: auto-replied") || e.mb.last().Thread != "t1" {
		t.Fatalf("auto-replies sent: %d", e.mb.count())
	}
	if strings.Contains(decoded(e.mb.last().Raw), "/o?t=") {
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
	// Cool-down: the same sender again within 24 hours gets no second reply.
	e.mb.inbox = append(e.mb.inbox, gmail.NewMessage("m3", "t3", e.now.Add(time.Minute), map[string]string{"From": "dan@delta.com", "To": "worker@example.com", "Subject": "Again"}, "Hi"))
	e.tick(t)
	if e.mb.count() != 1 {
		t.Error("cool-down ignored")
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
	// The WhatsApp sender is matched to Eve by phone (default country code is empty, so the
	// webhook's local number was stored as given; the chat id is international).
	if n := e.scalar(t, `SELECT count(*) FROM replies WHERE channel = 'whatsapp'`); n.(int64) != 1 {
		t.Errorf("whatsapp replies = %v", n)
	}
}

func TestNothingFailsWithoutGmail(t *testing.T) {
	e := setup(t)
	e.svc.MailboxOverride = nil // no Google client, no mailbox
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
	if s["campaigns"] != "Gmail not connected" {
		t.Errorf("summary = %v", s)
	}
	if e.scalar(t, `SELECT status FROM messages`) != "queued" {
		t.Error("mail must wait for Gmail, not fail")
	}
	// Dry-run mode records the send without a mailbox.
	if err := e.svc.UpdateSettings(ctx, map[string]any{"dry_run": true}); err != nil {
		t.Fatal(err)
	}
	e.tick(t)
	if e.scalar(t, `SELECT status FROM messages`) != "sent" || e.scalar(t, `SELECT dry_run FROM messages`) != true {
		t.Error("dry run should mark the message sent")
	}
}
