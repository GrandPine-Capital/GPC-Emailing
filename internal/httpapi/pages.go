package httpapi

import (
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
)

// The pages people outside the company see: unsubscribe, confirm a subscription, e-mail
// preferences and the hosted subscribe forms. No scripts; each is a plain form post.

var pages = template.Must(template.New("pages").Parse(`
{{define "head"}}<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>{{.Title}}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#f4f5f7;color:#374151;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;line-height:1.5}
.card{background:#fff;padding:32px;border-radius:12px;max-width:460px;width:100%;box-sizing:border-box;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
h2{margin-top:0;color:#111827}
button{background:#2563eb;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
button.danger{background:#dc2626}
form{text-align:left;margin-top:16px}
label.f{display:block;font-size:13px;font-weight:600;margin:12px 0 4px;color:#111827}
input[type=text],input[type=email],input[type=tel]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px}
.opt{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-size:15px}
.opt input{margin-top:4px}
.opt small{display:block;color:#6b7280}
.act{margin-top:20px;text-align:center}
.note{font-size:13px;color:#6b7280;margin-top:16px}
.ok{background:#ecfdf5;color:#065f46;padding:10px 12px;border-radius:8px;font-size:14px}
.err{background:#fef2f2;color:#991b1b;padding:10px 12px;border-radius:8px;font-size:14px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
a{color:#2563eb}
</style></head><body><div class="card">{{end}}
{{define "foot"}}</div></body></html>{{end}}

{{define "message"}}{{template "head" .}}<h2>{{.Title}}</h2><p>{{.Message}}</p>{{template "foot" .}}{{end}}

{{define "unsubscribe"}}{{template "head" .}}<h2>Unsubscribe</h2><p>Stop receiving these emails?</p>
<form method="post" action="/u?t={{.Token}}">
{{if .Ask}}<p style="margin:0 0 4px"><b>Would you tell us why?</b> <span class="note">(optional)</span></p>
{{range .Reasons}}<label class="opt"><input type="radio" name="reason" value="{{.}}"><span>{{.}}</span></label>{{end}}
<label class="f" for="other">Anything else</label><input type="text" id="other" name="other" maxlength="300">{{end}}
<div class="act"><button type="submit" class="danger">Unsubscribe me</button></div></form>
{{if .Manage}}<p class="note">Only want fewer emails? <a href="/m?t={{.Token}}">Choose what you receive</a> instead.</p>{{end}}
{{template "foot" .}}{{end}}

{{define "confirm"}}{{template "head" .}}<h2>Confirm your subscription</h2><p>Please confirm that <b>{{.Email}}</b> would like to receive our emails.</p>
<form method="post" action="/c?t={{.Token}}"><div class="act"><button type="submit">Yes, subscribe me</button></div></form>
<p class="note">Did not sign up? Close this page and you will not hear from us.</p>{{template "foot" .}}{{end}}

{{define "preferences"}}{{template "head" .}}<h2>Email preferences</h2><p>{{.P.Email}}</p>
{{if .Saved}}<p class="ok">Your preferences are saved.</p>{{end}}
{{if .Off}}<p class="note">This address is not receiving our emails at the moment.</p>{{end}}
<form method="post" action="/m?t={{.Token}}">
<label class="f" for="fn">First name</label><input type="text" id="fn" name="first_name" value="{{.P.FirstName}}" maxlength="100">
<label class="f" for="ln">Last name</label><input type="text" id="ln" name="last_name" value="{{.P.LastName}}" maxlength="100">
{{if .P.Lists}}<p style="margin:18px 0 4px"><b>Send me</b></p>
{{range .P.Lists}}<label class="opt"><input type="checkbox" name="lists" value="{{.ID}}" {{if .Member}}checked{{end}}><span>{{.Name}}{{if .Description}}<small>{{.Description}}</small>{{end}}</span></label>{{end}}{{end}}
<div class="act"><button type="submit">Save preferences</button></div></form>
<p class="note"><a href="/u?t={{.Token}}">Unsubscribe from all emails</a></p>{{template "foot" .}}{{end}}

{{define "form"}}{{template "head" .}}<h2>{{.Title}}</h2>{{if .Description}}<p>{{.Description}}</p>{{end}}
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/f/{{.ID}}">
<label class="f" for="email">Email</label><input type="email" id="email" name="email" value="{{.Email}}" required maxlength="254" autocomplete="email">
{{range .Fields}}<label class="f" for="{{.Name}}">{{.Label}}</label><input type="{{.Type}}" id="{{.Name}}" name="{{.Name}}" value="{{.Value}}" maxlength="200">{{end}}
<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="hp" tabindex="-1" autocomplete="off"></label></div>
{{if .Consent}}<label class="opt"><input type="checkbox" name="consent" value="yes" required><span>{{.Consent}}</span></label>{{end}}
<div class="act"><button type="submit">{{.Button}}</button></div></form>
<p class="note">You can unsubscribe at any time with the link in every email.</p>{{template "foot" .}}{{end}}
`))

func renderPage(w http.ResponseWriter, status int, name string, data map[string]any) {
	publicHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = pages.ExecuteTemplate(w, name, data)
}

// unsubscribeReasons are offered on the unsubscribe page; the choice is kept on the contact.
var unsubscribeReasons = []string{
	"I no longer want to receive these emails",
	"I receive too many emails",
	"I never signed up for this",
	"The content is not relevant to me",
	"Other",
}

// postedForm reads a small urlencoded body (first value of each field). Unreadable bodies
// (a mailbox provider's one-click post, for one) give an empty map.
func postedForm(w http.ResponseWriter, r *http.Request) map[string]string {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		return map[string]string{}
	}
	form, err := parseForm(raw)
	if err != nil {
		return map[string]string{}
	}
	return form
}

func redirectTo(w http.ResponseWriter, r *http.Request, to string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, to, http.StatusSeeOther)
}

var formFieldLabels = map[string][2]string{
	"first_name": {"First name", "text"}, "last_name": {"Last name", "text"}, "phone": {"Phone", "tel"}, "company": {"Company", "text"},
}

func formData(f *app.PublicForm, values map[string]string, errMsg string) map[string]any {
	type field struct{ Name, Label, Type, Value string }
	fields := []field{}
	for _, name := range f.Fields {
		if l, ok := formFieldLabels[name]; ok {
			fields = append(fields, field{name, l[0], l[1], values[name]})
		}
	}
	title := f.Title
	if title == "" {
		title = "Subscribe"
	}
	return map[string]any{"Title": title, "Description": f.Description, "ID": f.ID, "Fields": fields, "Button": f.ButtonText,
		"Consent": f.ConsentText, "Error": errMsg, "Email": values["email"]}
}

func formCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Accept")
	h.Set("Access-Control-Max-Age", "600")
}

// submitForm takes a sign-up from the hosted page, a form embedded on another site (a plain
// post, answered with a page or the form's redirect) or a script (JSON in, JSON out).
func (s *Server) submitForm(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	asJSON := strings.Contains(r.Header.Get("Accept"), "application/json") || strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
	values := map[string]string{}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var in map[string]any
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err == nil {
			for k, v := range in {
				values[k] = sv(v)
				if b, ok := v.(bool); ok && b {
					values[k] = "yes"
				}
			}
		}
	} else {
		values = postedForm(w, r)
	}
	if asJSON {
		formCORS(w)
	}
	answer := func(status int, okay bool, state, message, redirect string, f *app.PublicForm) {
		switch {
		case asJSON:
			out := map[string]any{"ok": okay, "message": message}
			if okay {
				out["status"], out["redirect"] = state, redirect
			} else {
				out["error"] = message
			}
			writeJSON(w, status, out)
		case okay && redirect != "":
			redirectTo(w, r, redirect)
		case okay:
			showPage(w, status, "Thank you", message)
		case f != nil && f.Status == "active":
			renderPage(w, status, "form", formData(f, values, message))
		default:
			showPage(w, status, "Sign up", message)
		}
	}
	if !s.formLimit.allow(clientIP(r)) {
		answer(http.StatusTooManyRequests, false, "", "Too many sign-ups from this connection. Please try again in a minute.", "", nil)
		return
	}
	if values["hp"] != "" {
		// A bot filled the hidden field: answer as if it worked, record nothing.
		answer(http.StatusOK, true, "subscribed", "Thank you for subscribing.", "", nil)
		return
	}
	outcome, f, err := s.svc.SubmitForm(r.Context(), id, values)
	var ue app.UserError
	switch {
	case app.IsNotFound(err):
		answer(http.StatusNotFound, false, "", "This form is not available.", "", nil)
		return
	case errors.As(err, &ue):
		answer(http.StatusBadRequest, false, "", ue.Msg, "", f)
		return
	case err != nil:
		s.log.ErrorContext(r.Context(), "form", "form", id, "err", err)
		answer(http.StatusInternalServerError, false, "", "Something went wrong, please try again.", "", f)
		return
	}
	message := f.SuccessMessage
	if message == "" {
		message = "Thank you for subscribing."
		if outcome == "pending" {
			message = "Almost done: we have sent you an email. Please click the link in it to confirm your subscription."
		}
	}
	answer(http.StatusOK, true, outcome, message, f.RedirectURL, f)
}

// clientIP is the address the load balancer saw (the last X-Forwarded-For entry), else the peer.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// limiter allows max events per window for each key (sign-ups per address).
type limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	seen   map[string][]time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, seen: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.seen) > 20000 {
		l.seen = map[string][]time.Time{}
	}
	recent := l.seen[key][:0]
	for _, t := range l.seen[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.max {
		l.seen[key] = recent
		return false
	}
	l.seen[key] = append(recent, now)
	return true
}
