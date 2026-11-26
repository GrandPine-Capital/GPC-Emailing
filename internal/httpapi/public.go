package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
)

// The routes e-mail recipients and other apps reach, without signing in.

// A 1×1 transparent GIF.
var pixel = []byte{0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
	0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b}

func publicHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
}

// showPage is a plain message page.
func showPage(w http.ResponseWriter, status int, title, message string) {
	renderPage(w, status, "message", map[string]any{"Title": title, "Message": message})
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
			showPage(w, http.StatusBadRequest, "Link not valid", "This link is invalid.")
			return
		}
		target, err := svc.Click(r.Context(), t, k)
		if err != nil {
			s.log.ErrorContext(r.Context(), "click", "err", err)
		}
		if target == "" {
			showPage(w, http.StatusNotFound, "Link expired", "This link has expired.")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.Redirect(w, r, target, http.StatusFound)
	}
	mux.HandleFunc("GET /r", click)
	mux.HandleFunc("GET /r.html", click)

	// Unsubscribe page: GET asks (and why, when Settings says so), POST does it (also at /u.html).
	unsubPage := func(w http.ResponseWriter, r *http.Request) {
		t := r.URL.Query().Get("t")
		if !svc.ValidUnsubscribeToken(r.Context(), t) {
			showPage(w, http.StatusOK, "Unsubscribe", "This link is a preview or has expired.")
			return
		}
		ask, _ := svc.UnsubscribeOptions(r.Context())
		data := map[string]any{"Title": "Unsubscribe", "Token": t, "Ask": ask, "Reasons": unsubscribeReasons}
		if p, err := svc.Preferences(r.Context(), t); err == nil && len(p.Lists) > 0 {
			data["Manage"] = true
		}
		renderPage(w, http.StatusOK, "unsubscribe", data)
	}
	mux.HandleFunc("GET /u", unsubPage)
	mux.HandleFunc("GET /u.html", unsubPage)
	mux.HandleFunc("POST /u", func(w http.ResponseWriter, r *http.Request) {
		form := postedForm(w, r)
		reason := form["reason"]
		if other := strings.TrimSpace(form["other"]); other != "" && (reason == "" || reason == "Other") {
			reason = other
		}
		if _, err := svc.UnsubscribeWithReason(r.Context(), r.URL.Query().Get("t"), reason); err != nil {
			s.log.ErrorContext(r.Context(), "unsubscribe", "err", err)
			showPage(w, http.StatusInternalServerError, "Unsubscribe", `Something went wrong, please try again or reply "unsubscribe" to the email.`)
			return
		}
		if _, to := svc.UnsubscribeOptions(r.Context()); to != "" {
			redirectTo(w, r, to)
			return
		}
		showPage(w, http.StatusOK, "You're unsubscribed", "You will no longer receive these emails.")
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

	// Double opt-in: GET asks, POST confirms, so a mail scanner that follows links confirms nothing.
	mux.HandleFunc("GET /c", func(w http.ResponseWriter, r *http.Request) {
		t := r.URL.Query().Get("t")
		email, status, valid := svc.OptInInfo(r.Context(), t)
		switch {
		case !valid || (status != "pending" && status != "subscribed"):
			showPage(w, http.StatusOK, "Confirm subscription", "This link has expired. Please sign up again.")
		case status == "subscribed":
			msg, _ := svc.OptInLanding(r.Context())
			showPage(w, http.StatusOK, "You're subscribed", msg)
		default:
			renderPage(w, http.StatusOK, "confirm", map[string]any{"Title": "Confirm your subscription", "Token": t, "Email": email})
		}
	})
	mux.HandleFunc("POST /c", func(w http.ResponseWriter, r *http.Request) {
		done, err := svc.Confirm(r.Context(), r.URL.Query().Get("t"))
		if err != nil {
			s.log.ErrorContext(r.Context(), "confirm", "err", err)
			showPage(w, http.StatusInternalServerError, "Confirm subscription", "Something went wrong, please try again.")
			return
		}
		if !done {
			showPage(w, http.StatusOK, "Confirm subscription", "This link has expired. Please sign up again.")
			return
		}
		msg, to := svc.OptInLanding(r.Context())
		if to != "" {
			redirectTo(w, r, to)
			return
		}
		showPage(w, http.StatusOK, "You're subscribed", msg)
	})

	// Preference page: the subscriber's name and the public lists they are on.
	prefs := func(w http.ResponseWriter, r *http.Request, saved bool) {
		t := r.URL.Query().Get("t")
		p, err := svc.Preferences(r.Context(), t)
		if err != nil {
			if !app.IsNotFound(err) {
				s.log.ErrorContext(r.Context(), "preferences", "err", err)
			}
			showPage(w, http.StatusOK, "Email preferences", "This link is a preview or has expired.")
			return
		}
		renderPage(w, http.StatusOK, "preferences", map[string]any{"Title": "Email preferences", "Token": t, "P": p, "Saved": saved,
			"Off": p.Status != "subscribed"})
	}
	mux.HandleFunc("GET /m", func(w http.ResponseWriter, r *http.Request) { prefs(w, r, false) })
	mux.HandleFunc("POST /m", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			showPage(w, http.StatusBadRequest, "Email preferences", "That did not work, please try again.")
			return
		}
		err := svc.SavePreferences(r.Context(), r.URL.Query().Get("t"), r.PostForm.Get("first_name"), r.PostForm.Get("last_name"), r.PostForm["lists"])
		if err != nil && !app.IsNotFound(err) {
			s.log.ErrorContext(r.Context(), "preferences", "err", err)
			showPage(w, http.StatusInternalServerError, "Email preferences", "Something went wrong, please try again.")
			return
		}
		prefs(w, r, err == nil)
	})

	// "View in browser": the e-mail as its recipient got it, untracked. It is somebody's HTML, so
	// it is served sandboxed: no scripts, and no access to this site's origin.
	mux.HandleFunc("GET /v", func(w http.ResponseWriter, r *http.Request) {
		_, html, err := svc.ViewOnline(r.Context(), r.URL.Query().Get("t"))
		if err != nil {
			if !app.IsNotFound(err) {
				s.log.ErrorContext(r.Context(), "view online", "err", err)
			}
			showPage(w, http.StatusOK, "Email", "This email is a preview or is no longer available.")
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Robots-Tag", "noindex")
		h.Set("Content-Security-Policy", "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, html)
	})

	// Subscribe forms: the hosted page, and the post from it or from a form embedded elsewhere.
	mux.HandleFunc("GET /f/{id}", func(w http.ResponseWriter, r *http.Request) {
		f, err := svc.PublicForm(r.Context(), r.PathValue("id"))
		if err != nil || f.Status != "active" {
			showPage(w, http.StatusNotFound, "Sign up", "This form is not available.")
			return
		}
		renderPage(w, http.StatusOK, "form", formData(f, nil, ""))
	})
	mux.HandleFunc("OPTIONS /f/{id}", func(w http.ResponseWriter, r *http.Request) {
		formCORS(w)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /f/{id}", s.submitForm)

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

	// GPC-CSTicket's signed requests: the customer password-reset e-mail.
	mux.HandleFunc("POST /hooks/helpdesk", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandleHelpdeskEvent(r.Context(), r.Header.Get("sig"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrHelpdeskHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "helpdesk event", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// The Keycloak e-mail hook's signed events: account e-mails (new password, verify address).
	// "handled": false in the answer tells Keycloak to send its own e-mail instead.
	mux.HandleFunc("POST /hooks/keycloak", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandleKeycloakEvent(r.Context(), r.Header.Get("sig"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrKeycloakHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "keycloak event", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// The CRM's signed contact sync (quiet: no automations, no sends).
	mux.HandleFunc("POST /hooks/crm/contacts", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandleCRMContacts(r.Context(), r.Header.Get("sig"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrCRMHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "crm contacts", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// The CRM's signed connection test.
	mux.HandleFunc("POST /hooks/crm/ping", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandleCRMPing(r.Context(), r.Header.Get("sig"), raw)
		switch {
		case errors.Is(err, app.ErrCRMHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case err != nil:
			s.log.ErrorContext(r.Context(), "crm ping", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// The CRM's signed requests for a transactional e-mail.
	mux.HandleFunc("POST /hooks/crm/events", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		out, err := svc.HandleCRMEvent(r.Context(), r.Header.Get("sig"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrCRMHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "crm event", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		default:
			writeJSON(w, http.StatusOK, out)
		}
	})

	// GPC-WhatsApp's signed outbound webhooks: incoming messages and delivery status.
	mux.HandleFunc("POST /hooks/whatsapp", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
		if err != nil {
			writeError(w, http.StatusBadRequest, "body too large")
			return
		}
		out, err := svc.HandleWhatsAppHook(r.Context(), r.Header.Get("X-GPC-Event"), r.Header.Get("X-GPC-Signature"), raw)
		var ue app.UserError
		switch {
		case errors.Is(err, app.ErrWhatsAppHookOff):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, app.ErrBadSignature):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.As(err, &ue):
			writeError(w, http.StatusBadRequest, ue.Msg)
		case err != nil:
			s.log.ErrorContext(r.Context(), "whatsapp hook", "err", err)
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
