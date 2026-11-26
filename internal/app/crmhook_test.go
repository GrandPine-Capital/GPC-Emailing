package app_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

const crmSecret = "test-crm-secret"

func signCRM(body string) string {
	m := hmac.New(sha256.New, []byte(crmSecret))
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))
}

func (e *env) crmOn(t *testing.T) {
	t.Helper()
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"crm_hook_secret": crmSecret}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) crmContacts(t *testing.T, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandleCRMContacts(e.ctx, signCRM(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e *env) crmEvent(t *testing.T, body string) map[string]any {
	t.Helper()
	out, err := e.svc.HandleCRMEvent(e.ctx, signCRM(body), []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// counts checks created/updated/unchanged and the number of invalid entries.
func counts(t *testing.T, out map[string]any, created, updated, unchanged, invalid int) {
	t.Helper()
	if n := strings.Count(fmt.Sprintf("%+v", out["invalid"]), "Index:"); out["created"] != created || out["updated"] != updated || out["unchanged"] != unchanged || n != invalid {
		t.Fatalf("want created %d updated %d unchanged %d invalid %d, got %v", created, updated, unchanged, invalid, out)
	}
}

func (e *env) contactField(t *testing.T, id, col string) string {
	t.Helper()
	var v string
	if err := e.db.Pool.QueryRow(e.ctx, `SELECT `+col+`::text FROM contacts WHERE id = $1`, id).Scan(&v); err != nil {
		t.Fatalf("%s: %v", col, err)
	}
	return v
}

func TestCRMHookGuards(t *testing.T) {
	e := setup(t, true)
	body := `{"tagPrefix":"crm:","contacts":[]}`
	if _, err := e.svc.HandleCRMContacts(e.ctx, signCRM(body), []byte(body)); !errors.Is(err, app.ErrCRMHookOff) {
		t.Fatalf("contacts without a secret: %v", err)
	}
	ev := `{"type":"crm.owner_alert","key":"k"}`
	if _, err := e.svc.HandleCRMEvent(e.ctx, signCRM(ev), []byte(ev)); !errors.Is(err, app.ErrCRMHookOff) {
		t.Fatalf("events without a secret: %v", err)
	}
	e.crmOn(t)
	if _, err := e.svc.HandleCRMContacts(e.ctx, "00"+signCRM(body)[2:], []byte(body)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	if _, err := e.svc.HandleCRMEvent(e.ctx, "", []byte(ev)); !errors.Is(err, app.ErrBadSignature) {
		t.Fatalf("missing signature: %v", err)
	}
	for _, bad := range []string{`nope`, `{"contacts":[]}`, `{"tagPrefix":"abcdefghijklmnopqrstu","contacts":[]}`} {
		if _, err := e.svc.HandleCRMContacts(e.ctx, signCRM(bad), []byte(bad)); err == nil || errors.Is(err, app.ErrBadSignature) {
			t.Errorf("%q should be a 400, got %v", bad, err)
		} else if _, ok := err.(app.UserError); !ok {
			t.Errorf("%q: not a user error: %v", bad, err)
		}
	}
	if _, err := e.svc.HandleCRMEvent(e.ctx, signCRM(`x`), []byte(`x`)); err == nil {
		t.Error("malformed event accepted")
	}
}

func TestCRMContactsCreateAndOverwrite(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	if err := e.svc.UpdateSettings(e.ctx, map[string]any{"default_country_code": "60"}); err != nil {
		t.Fatal(err)
	}
	out := e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[
		{"email":"A@B.my","externalId":"82092","name":"Tan Ah Kow","phone":"012-345 6789","tags":["crm:vip","crm:cat:customer"],"subscribed":true},
		{"email":"quiet@b.my","name":"Lee","subscribed":false}]}`)
	counts(t, out, 2, 0, 0, 0)
	if e.contactField(t, "a@b.my", "first_name") != "Tan" || e.contactField(t, "a@b.my", "last_name") != "Ah Kow" ||
		e.contactField(t, "a@b.my", "phone_key") != "60123456789" || e.contactField(t, "a@b.my", "source") != "crm" ||
		e.contactField(t, "a@b.my", "status") != "subscribed" || e.contactField(t, "a@b.my", "array_to_string(tags, ',')") != "crm:vip,crm:cat:customer" {
		t.Fatal("created contact is wrong")
	}
	if e.contactField(t, "quiet@b.my", "status") != "unsubscribed" {
		t.Fatal("subscribed:false on create should be unsubscribed")
	}

	// Present: other tags, a list and an unsubscribed status survive; name and phone are overwritten.
	e.db.Pool.Exec(e.ctx, `UPDATE contacts SET tags = tags || '{manual}', list_ids = '{l1}', status = 'unsubscribed' WHERE id = 'a@b.my'`)
	out = e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[
		{"email":"a@b.my","name":"Tan Kow","phone":"+60111222333","tags":["crm:gold"],"subscribed":true},
		{"email":"quiet@b.my","subscribed":true}]}`)
	counts(t, out, 0, 1, 1, 0)
	if e.contactField(t, "a@b.my", "array_to_string(tags, ',')") != "manual,crm:gold" || e.contactField(t, "a@b.my", "list_ids") != "{l1}" ||
		e.contactField(t, "a@b.my", "status") != "unsubscribed" || e.contactField(t, "a@b.my", "last_name") != "Kow" ||
		e.contactField(t, "a@b.my", "phone_key") != "60111222333" {
		t.Fatal("update is wrong")
	}
	if e.contactField(t, "quiet@b.my", "status") != "unsubscribed" {
		t.Fatal("subscribed:true must not resubscribe")
	}
	// Empty name and phone leave the stored ones.
	out = e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[{"email":"a@b.my","name":"","phone":"","tags":["crm:gold"]}]}`)
	counts(t, out, 0, 0, 1, 0)
	// A repeat is all unchanged.
	body := `{"tagPrefix":"crm:","contacts":[{"email":"a@b.my","name":"Tan Kow","phone":"+60111222333","tags":["crm:gold"]},{"email":"quiet@b.my"}]}`
	counts(t, e.crmContacts(t, body), 0, 0, 2, 0)
}

func TestCRMContactsRemoveInvalidAndLimit(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[{"email":"a@b.my","tags":["crm:vip"]}]}`)
	e.db.Pool.Exec(e.ctx, `UPDATE contacts SET tags = tags || '{manual}' WHERE id = 'a@b.my'`)
	out := e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[
		{"email":"a@b.my","remove":true},{"email":"ghost@b.my","remove":true},
		{"email":"bad address","name":"Secret Name"},
		{"email":"c@b.my","tags":["other:x"]},
		{"email":"d@b.my","tags":["crm:ok"]}]}`)
	counts(t, out, 1, 1, 1, 2)
	if got := e.contactField(t, "a@b.my", "array_to_string(tags, ',')"); got != "manual" {
		t.Fatalf("remove left %q", got)
	}
	if e.scalar(t, `SELECT count(*) FROM contacts WHERE id = 'ghost@b.my'`) != int64(0) || e.contactField(t, "d@b.my", "tags") != "{crm:ok}" {
		t.Fatal("ghost created or valid contact missed")
	}
	s := fmt.Sprintf("%+v", out["invalid"])
	if !strings.Contains(s, "Index:2") || !strings.Contains(s, "Index:3") || strings.Contains(s, "Secret") || strings.Contains(s, "bad address") || strings.Contains(s, "other:x") {
		t.Fatalf("invalid report %s", s)
	}
	var many []string
	for i := 0; i < 501; i++ {
		many = append(many, fmt.Sprintf(`{"email":"u%d@b.my"}`, i))
	}
	big := `{"tagPrefix":"crm:","contacts":[` + strings.Join(many, ",") + `]}`
	if _, err := e.svc.HandleCRMContacts(e.ctx, signCRM(big), []byte(big)); err == nil {
		t.Fatal("501 contacts accepted")
	} else if _, ok := err.(app.UserError); !ok {
		t.Fatal(err)
	}
	if e.scalar(t, `SELECT count(*) FROM contacts WHERE id LIKE 'u%'`) != int64(0) {
		t.Fatal("nothing should be applied")
	}
	big = `{"tagPrefix":"crm:","contacts":[` + strings.Join(many[:500], ",") + `]}`
	counts(t, e.crmContacts(t, big), 500, 0, 0, 0)
}

func TestCRMContactsAreQuiet(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	for _, trig := range []string{"contact_added", "tag_added"} {
		if _, err := e.svc.CreateAutomation(e.ctx, map[string]any{"name": trig, "trigger_type": trig, "status": "active",
			"steps": []any{map[string]any{"type": "send_email", "template_id": "std-welcome-email"}}}); err != nil {
			t.Fatal(err)
		}
	}
	e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[{"email":"a@b.my","phone":"+60123456789","tags":["crm:vip"]}]}`)
	e.crmContacts(t, `{"tagPrefix":"crm:","contacts":[{"email":"a@b.my","tags":["crm:gold"]}]}`)
	e.tick(t)
	if e.scalar(t, `SELECT count(*) FROM runs`) != int64(0) || e.scalar(t, `SELECT count(*) FROM transactional`) != int64(0) || e.ses.count() != 0 {
		t.Fatal("the sync started an automation or sent something")
	}
	// Control: the same automations do start for an ordinary contact, so the check above means something.
	if _, err := e.svc.CreateContact(e.ctx, app.ContactInput{Email: "control@b.my", Tags: []string{"x"}}); err != nil {
		t.Fatal(err)
	}
	if e.scalar(t, `SELECT count(*) FROM runs`) == int64(0) {
		t.Fatal("control: an ordinary contact should start the active automations")
	}
}

func crmEventBody(typ, key string, vars string) string {
	return `{"type":"` + typ + `","key":"` + key + `","to":{"name":"Tan Ah Kow","email":"A@B.my"},"vars":` + vars + `}`
}

const crmVars = `{"product":"VF Pro","amount":"199.00","currency":"MYR","reference":"INV-1"}`

func TestCRMEvents(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	for i, typ := range []string{"crm.payment_failed", "crm.registration_confirmed", "crm.registration_failed"} {
		key := "k-" + typ
		out := e.crmEvent(t, crmEventBody(typ, key, crmVars))
		if out["ok"] != true || out["created"] != true || out["status"] != "sent" {
			t.Fatalf("%s: %v", typ, out)
		}
		tmpl := strings.ReplaceAll(typ, ".", "_")
		if e.scalar(t, `SELECT template_key FROM transactional WHERE source = 'crm' AND source_key = $1`, key) != tmpl {
			t.Errorf("%s: wrong template", typ)
		}
		msg := decoded(e.ses.since(i)[0])
		if !strings.Contains(msg, "<a@b.my>") || !strings.Contains(msg, "VF Pro") || !strings.Contains(msg, "INV-1") || !strings.Contains(msg, "Tan") || strings.Contains(msg, "{{") {
			t.Errorf("%s mail: %s", typ, msg)
		}
		// Same key again: one row, answered created:false, nothing more sent.
		again := e.crmEvent(t, crmEventBody(typ, key, crmVars))
		if again["created"] != false || again["id"] != out["id"] {
			t.Errorf("%s repeat: %v", typ, again)
		}
	}
	if e.scalar(t, `SELECT count(*) FROM transactional WHERE source = 'crm'`) != int64(3) || e.ses.count() != 3 {
		t.Fatalf("rows or sends: %d", e.ses.count())
	}
	if e.scalar(t, `SELECT count(*) FROM contacts`) != int64(0) {
		t.Fatal("a transactional e-mail must not create a contact")
	}
}

func TestCRMEventIgnored(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	if out := e.crmEvent(t, crmEventBody("crm.unknown", "k1", crmVars)); out["ignored"] == nil || out["id"] != nil {
		t.Fatalf("unknown type: %v", out)
	}
	if out := e.crmEvent(t, strings.Replace(crmEventBody("crm.payment_failed", "k2", crmVars), "A@B.my", "", 1)); out["ignored"] != "no e-mail address" {
		t.Fatalf("no address: %v", out)
	}
	if err := e.svc.SaveTransactionalConfig(e.ctx, map[string]any{"events": map[string]any{"crm.payment_failed": map[string]any{"enabled": false}}}); err != nil {
		t.Fatal(err)
	}
	if out := e.crmEvent(t, crmEventBody("crm.payment_failed", "k3", crmVars)); out["ignored"] == nil || out["id"] != nil {
		t.Fatalf("switched off: %v", out)
	}
	if e.scalar(t, `SELECT count(*) FROM transactional`) != int64(0) || e.ses.count() != 0 {
		t.Fatal("something was queued")
	}
}

func TestCRMOwnerAlert(t *testing.T) {
	e := setup(t, true)
	e.crmOn(t)
	body := `{"type":"crm.owner_alert","key":"alert-1","to":{"email":"owner@grandpine.test"},"vars":{"subject":"Lead <b>hot</b>\nnow","body":"Line one <script>alert(1)</script>\n\nLine & two"}}`
	out := e.crmEvent(t, body)
	if out["status"] != "sent" {
		t.Fatal(out)
	}
	msg := decoded(e.ses.since(0)[0])
	if strings.Contains(msg, "<script>") || !strings.Contains(msg, "&lt;script&gt;alert(1)&lt;/script&gt;") || !strings.Contains(msg, "Line &amp; two") {
		t.Fatalf("body not escaped: %s", msg)
	}
	if !strings.Contains(msg, "owner@grandpine.test") || strings.Contains(msg, "{{") {
		t.Fatalf("mail: %s", msg)
	}
	if _, err := e.svc.HandleCRMEvent(e.ctx, signCRM(`{"type":"crm.owner_alert","key":"a2","to":{"email":"o@g.test"},"vars":{}}`), []byte(`{"type":"crm.owner_alert","key":"a2","to":{"email":"o@g.test"},"vars":{}}`)); err == nil {
		t.Fatal("an alert with no subject or body was accepted")
	}
}
