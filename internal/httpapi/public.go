package httpapi

import (
	"errors"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
)

// The routes e-mail recipients and other apps reach, without signing in.

// A 1×1 transparent GIF.
var pixel = []byte{0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
	0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b}

var page = template.Must(template.New("page").Parse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>{{.Title}}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#f4f5f7;color:#374151;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{background:#fff;padding:32px;border-radius:12px;max-width:440px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
h2{margin-top:0}button{background:#dc2626;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer}
</style></head><body><div class="card"><h2>{{.Title}}</h2><p>{{.Message}}</p>
{{if .Token}}<form method="post" action="/u?t={{.Token}}"><button type="submit">Unsubscribe me</button></form>{{end}}
</div></body></html>`))

func publicHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
}

func showPage(w http.ResponseWriter, status int, title, message, token string) {
	publicHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = page.Execute(w, map[string]string{"Title": title, "Message": message, "Token": token})
}

var keyRe = regexp.MustCompile(`^[a-f0-9]{24}$`)

func (s *Server) public(mux *http.ServeMux) {
	svc := s.svc

	// Open pixel.
	mux.HandleFunc("GET /o", func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Open(r.Context(), r.URL.Query().Get("t")); err != nil {
			s.log.ErrorContext(r.Context(), "open", "err", err)
		}
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-store, max-age=0")
		_, _ = w.Write(pixel)
	})

	// Click redirect (also at /r.html, the Firebase build's path).
	click := func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		t, k := q.Get("t"), q.Get("k")
		if !ids.IsToken(t) || !keyRe.MatchString(k) {
			showPage(w, http.StatusBadRequest, "Link not valid", "This link is invalid.", "")
			return
		}
		target, err := svc.Click(r.Context(), t, k)
		if err != nil {
			s.log.ErrorContext(r.Context(), "click", "err", err)
		}
		if target == "" {
			showPage(w, http.StatusNotFound, "Link expired", "This link has expired.", "")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.Redirect(w, r, target, http.StatusFound)
	}
	mux.HandleFunc("GET /r", click)
	mux.HandleFunc("GET /r.html", click)

	// Unsubscribe page: GET asks, POST does it (also at /u.html).
	unsubPage := func(w http.ResponseWriter, r *http.Request) {
		t := r.URL.Query().Get("t")
		if !svc.ValidUnsubscribeToken(r.Context(), t) {
			showPage(w, http.StatusOK, "Unsubscribe", "This link is a preview or has expired.", "")
			return
		}
		showPage(w, http.StatusOK, "Unsubscribe", "Stop receiving these emails?", t)
	}
	mux.HandleFunc("GET /u", unsubPage)
	mux.HandleFunc("GET /u.html", unsubPage)
	mux.HandleFunc("POST /u", func(w http.ResponseWriter, r *http.Request) {
		if _, err := svc.Unsubscribe(r.Context(), r.URL.Query().Get("t")); err != nil {
			s.log.ErrorContext(r.Context(), "unsubscribe", "err", err)
			showPage(w, http.StatusInternalServerError, "Unsubscribe", `Something went wrong, please try again or reply "unsubscribe" to the email.`, "")
			return
		}
		showPage(w, http.StatusOK, "You're unsubscribed", "You will no longer receive these emails.", "")
	})
	// RFC 8058 one-click unsubscribe from mailbox providers (List-Unsubscribe-Post).
	mux.HandleFunc("POST /u1", func(w http.ResponseWriter, r *http.Request) {
		if _, err := svc.Unsubscribe(r.Context(), r.URL.Query().Get("t")); err != nil {
			s.log.ErrorContext(r.Context(), "one-click unsubscribe", "err", err)
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, "unsubscribed")
	})
	mux.HandleFunc("GET /u1", unsubPage)

	// Inbound webhooks (ChatDaddy, forms, Zapier, CRMs), keyed by the webhook secret.
	mux.HandleFunc("POST /hook", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		params := query(r)
		if ct := r.Header.Get("Content-Type"); len(raw) > 0 && regexp.MustCompile(`(?i)application/x-www-form-urlencoded`).MatchString(ct) {
			if form, err := parseForm(raw); err == nil {
				for k, v := range form {
					if _, set := params[k]; !set {
						params[k] = v
					}
				}
				raw = nil
			}
		}
		out, err := svc.HandleWebhook(r.Context(), params, raw)
		switch {
		case errors.Is(err, app.ErrBadWebhookKey):
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": err.Error()})
		case err != nil:
			var ue app.UserError
			if errors.As(err, &ue) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": ue.Msg})
				return
			}
			s.log.ErrorContext(r.Context(), "webhook", "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal error"})
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// GPC-Payment's signed events: receipts, bank-transfer instructions, refund notices.
	mux.HandleFunc("POST /hooks/payments", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandlePaymentEvent(r.Context(), r.Header.Get("sig"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "payment event", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// Images uploaded in the e-mail builder.
	mux.HandleFunc("GET /img/{id}", func(w http.ResponseWriter, r *http.Request) {
		mime, data, err := svc.Upload(r.Context(), r.PathValue("id"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		publicHeaders(w)
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		_, _ = w.Write(data)
	})
}

func parseForm(raw []byte) (map[string]string, error) {
	vals, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, v := range vals {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out, nil
}
