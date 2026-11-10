package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/auth"
	"github.com/grandpine-capital/gpc-emailing/internal/core"
)

func query(r *http.Request) map[string]string {
	out := map[string]string{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}

type body = map[string]any

func strs(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, x := range list {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func sv(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return ""
}

func (s *Server) routes(mux *http.ServeMux) {
	const p = "/api"
	svc := s.svc
	h := func(pattern string, fn http.HandlerFunc) { mux.Handle(pattern, s.signedIn(fn)) }
	adm := func(pattern string, fn http.HandlerFunc) { mux.Handle(pattern, s.admin(fn)) }
	withBody := func(fn func(w http.ResponseWriter, r *http.Request, b body)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b := body{}
			if r.ContentLength != 0 && !decode(w, r, &b) {
				return
			}
			fn(w, r, b)
		}
	}
	id := func(r *http.Request) string { return r.PathValue("id") }

	// sign-in
	mux.HandleFunc("GET "+p+"/public/sign-in", s.signInConfig)
	mux.HandleFunc("POST "+p+"/public/sign-in/code", s.signInCode)
	mux.HandleFunc("POST "+p+"/public/sign-in/refresh", s.signInRefresh)

	h("GET "+p+"/me", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, user(r)) })
	h("GET "+p+"/meta", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, svc.Meta(r.Context(), user(r).Role)) })
	h("GET "+p+"/stats", func(w http.ResponseWriter, r *http.Request) { v, err := svc.Stats(r.Context()); s.reply(w, r, v, err) })

	// templates
	h("GET "+p+"/templates", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Templates(r.Context())
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/templates/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Template(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/templates", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateTemplate(r.Context(), b)
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/templates/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateTemplate(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("POST "+p+"/templates/{id}/duplicate", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.DuplicateTemplate(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("DELETE "+p+"/templates/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.DeleteTemplate(r.Context(), id(r)))
	})
	h("POST "+p+"/templates/{id}/test", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.SendTest(r.Context(), sv(b["email"]), id(r), "")
		s.reply(w, r, v, err)
	}))
	h("POST "+p+"/uploads", s.upload)

	// lists
	h("GET "+p+"/lists", func(w http.ResponseWriter, r *http.Request) { v, err := svc.Lists(r.Context()); s.reply(w, r, v, err) })
	h("POST "+p+"/lists", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateList(r.Context(), sv(b["name"]), sv(b["description"]))
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/lists/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateList(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("DELETE "+p+"/lists/{id}", func(w http.ResponseWriter, r *http.Request) { s.reply(w, r, ok, svc.DeleteList(r.Context(), id(r))) })
	h("POST "+p+"/lists/{id}/contacts", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		n, err := svc.AddToList(r.Context(), strs(b["contact_ids"]), id(r))
		s.reply(w, r, map[string]any{"added": n}, err)
	}))
	h("POST "+p+"/lists/{id}/remove-contacts", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		s.reply(w, r, ok, svc.RemoveFromList(r.Context(), strs(b["contact_ids"]), id(r)))
	}))

	// contacts
	h("GET "+p+"/contacts", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.ListContacts(r.Context(), query(r))
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/contacts/facets", func(w http.ResponseWriter, r *http.Request) { v, err := svc.Facets(r.Context()); s.reply(w, r, v, err) })
	h("GET "+p+"/contacts/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.ContactDetail(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/contacts", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateContact(r.Context(), app.ContactInput{
			Email: sv(b["email"]), FirstName: sv(b["first_name"]), LastName: sv(b["last_name"]), Company: sv(b["company"]), Website: sv(b["website"]),
			Phone: sv(b["phone"]), Country: sv(b["country"]), Industry: sv(b["industry"]), Status: sv(b["status"]),
			Tags: tagsOf(b["tags"]), ListIDs: strs(b["list_ids"]),
		})
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/contacts/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateContact(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("DELETE "+p+"/contacts/{id}", func(w http.ResponseWriter, r *http.Request) { s.reply(w, r, ok, svc.DeleteContact(r.Context(), id(r))) })
	h("POST "+p+"/contacts/bulk", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		n, err := svc.BulkContacts(r.Context(), sv(b["action"]), strs(b["ids"]), sv(b["tag"]), sv(b["list_id"]))
		s.reply(w, r, map[string]any{"ok": true, "count": n}, err)
	}))
	h("POST "+p+"/contacts/import", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Rows     []map[string]string `json:"rows"`
			ListID   string              `json:"list_id"`
			Tags     string              `json:"tags"`
			Country  string              `json:"country"`
			Industry string              `json:"industry"`
		}
		if !decodeLimit(w, r, &in, 30<<20) {
			return
		}
		v, err := svc.ImportContacts(r.Context(), in.Rows, in.ListID, core.SplitTags(in.Tags), in.Country, in.Industry)
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/contacts/export", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		qp := map[string]string{}
		for k, v := range b {
			qp[k] = sv(v)
		}
		v, err := svc.ExportContacts(r.Context(), qp)
		s.reply(w, r, v, err)
	}))

	// campaigns
	h("GET "+p+"/campaigns", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Campaigns(r.Context())
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/campaigns/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Campaign(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/campaigns/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.CampaignMessages(r.Context(), id(r), r.URL.Query().Get("filter"))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/campaigns", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateCampaign(r.Context(), b)
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/campaigns/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateCampaign(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("DELETE "+p+"/campaigns/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.DeleteCampaign(r.Context(), id(r)))
	})
	h("POST "+p+"/campaigns/{id}/send", func(w http.ResponseWriter, r *http.Request) { s.reply(w, r, ok, svc.SendCampaign(r.Context(), id(r))) })
	h("POST "+p+"/campaigns/{id}/schedule", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		s.reply(w, r, ok, svc.ScheduleCampaign(r.Context(), id(r), sv(b["scheduled_at"])))
	}))
	for path, move := range map[string][2]string{"unschedule": {"scheduled", "draft"}, "pause": {"sending", "paused"}, "resume": {"paused", "sending"}} {
		h("POST "+p+"/campaigns/{id}/"+path, func(w http.ResponseWriter, r *http.Request) {
			s.reply(w, r, ok, svc.MoveCampaign(r.Context(), id(r), move[0], move[1]))
		})
	}
	h("POST "+p+"/campaigns/{id}/duplicate", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.DuplicateCampaign(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/campaigns/{id}/test", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.SendTest(r.Context(), sv(b["email"]), "", id(r))
		s.reply(w, r, v, err)
	}))

	// automations
	h("GET "+p+"/automations", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Automations(r.Context())
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Automation(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/automations", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateAutomation(r.Context(), b)
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/automations/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateAutomation(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("POST "+p+"/automations/{id}/activate", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.SetAutomationStatus(r.Context(), id(r), "active"))
	})
	h("POST "+p+"/automations/{id}/pause", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.SetAutomationStatus(r.Context(), id(r), "paused"))
	})
	h("DELETE "+p+"/automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.DeleteAutomation(r.Context(), id(r)))
	})
	h("POST "+p+"/automations/{id}/enroll", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		if sv(b["list_id"]) == "" && len(strs(b["contact_ids"])) == 0 {
			writeError(w, http.StatusBadRequest, "Choose a list")
			return
		}
		n, err := svc.Enroll(r.Context(), id(r), strs(b["contact_ids"]), sv(b["list_id"]))
		s.reply(w, r, map[string]any{"queued": true, "enrolled": n}, err)
	}))
	h("POST "+p+"/automation-runs/{id}/stop", func(w http.ResponseWriter, r *http.Request) { s.reply(w, r, ok, svc.StopRun(r.Context(), id(r))) })

	// replies and the worker
	h("GET "+p+"/replies", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Replies(r.Context())
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/replies", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.LogReply(r.Context(), sv(b["from"]), sv(b["subject"]), sv(b["text"]))
		s.reply(w, r, v, err)
	}))
	h("POST "+p+"/replies/poll", func(w http.ResponseWriter, r *http.Request) {
		summary, err := svc.Tick(r.Context(), 90*time.Second)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		found, _ := summary["replies"].(int)
		writeJSON(w, 200, map[string]any{"found": found, "summary": summary})
	})

	// lead finder
	h("POST "+p+"/leads/search", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.StartLeadSearch(r.Context(), b)
		s.reply(w, r, v, err)
	}))
	h("GET "+p+"/leads/searches", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.LeadSearches(r.Context())
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/leads/searches/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.LeadSearch(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("DELETE "+p+"/leads/searches/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.DeleteLeadSearch(r.Context(), id(r)))
	})
	h("POST "+p+"/leads/searches/{id}/import", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.ImportLeads(r.Context(), id(r), strs(b["lead_ids"]), sv(b["list_id"]), tagsOf(b["tags"]))
		s.reply(w, r, v, err)
	}))

	// settings
	h("GET "+p+"/settings", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.SettingsView(r.Context(), user(r).IsAdmin())
		s.reply(w, r, v, err)
	})
	adm("PUT "+p+"/settings", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		s.reply(w, r, ok, svc.UpdateSettings(r.Context(), b))
	}))
	adm("POST "+p+"/settings/webhook-secret", func(w http.ResponseWriter, r *http.Request) {
		_, err := svc.RotateWebhookSecret(r.Context())
		s.reply(w, r, ok, err)
	})
	h("POST "+p+"/settings/check", func(w http.ResponseWriter, r *http.Request) {
		m := svc.MailStatus(r.Context())
		switch {
		case m["configured"] != true:
			writeJSON(w, 200, map[string]any{"ok": false, "message": app.ErrNoMailer.Error()})
			return
		case m["error"] != nil:
			writeJSON(w, 200, map[string]any{"ok": false, "message": "SES answered: " + sv(m["error"])})
			return
		}
		if _, err := svc.RefreshSenders(r.Context()); err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "message": "SES answered: " + err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "message": "Connected to Amazon SES (" + sv(m["region"]) + "). Sending as " + sv(m["default_from"]) + "; " +
			strconv.Itoa(svc.RemainingToday(r.Context())) + " emails left today."})
	})
	adm("POST "+p+"/senders/refresh", func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.RefreshSenders(r.Context())
		s.reply(w, r, map[string]any{"ok": true, "senders": list}, err)
	})
	adm("POST "+p+"/integrations/test-whatsapp", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		text := sv(b["text"])
		if text == "" {
			text = "Test message from GPC Emailing ✅"
		}
		err := svc.SendWhatsApp(r.Context(), sv(b["phone"]), app.WhatsAppOpts{Provider: sv(b["provider"]), Text: text})
		if err != nil {
			err = app.UserError{Msg: err.Error()}
		}
		s.reply(w, r, ok, err)
	}))

	// auto-reply rules and the inbox log
	h("GET "+p+"/autoreplies", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.AutoReplies(r.Context())
		s.reply(w, r, v, err)
	})
	h("GET "+p+"/autoreplies/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.AutoReplyRule(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("POST "+p+"/autoreplies", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.CreateAutoReply(r.Context(), b)
		s.reply(w, r, v, err)
	}))
	h("PUT "+p+"/autoreplies/{id}", withBody(func(w http.ResponseWriter, r *http.Request, b body) {
		v, err := svc.UpdateAutoReply(r.Context(), id(r), b)
		s.reply(w, r, v, err)
	}))
	h("POST "+p+"/autoreplies/{id}/toggle", func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.ToggleAutoReply(r.Context(), id(r))
		s.reply(w, r, v, err)
	})
	h("DELETE "+p+"/autoreplies/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.reply(w, r, ok, svc.DeleteAutoReply(r.Context(), id(r)))
	})
	h("GET "+p+"/inbound", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		v, err := svc.Inbound(r.Context(), n)
		s.reply(w, r, v, err)
	})
}

func tagsOf(v any) []string {
	switch x := v.(type) {
	case string:
		return core.SplitTags(x)
	case []any:
		return core.NormaliseTags(strs(x))
	}
	return nil
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, app.MaxUpload+(1<<20))
	if err := r.ParseMultipartForm(app.MaxUpload); err != nil {
		writeError(w, http.StatusBadRequest, "Image is larger than 5 MB")
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Choose an image")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, app.MaxUpload+1))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	mime := hdr.Header.Get("Content-Type")
	if sniffed := http.DetectContentType(data); sniffed != mime {
		mime = sniffed // trust the bytes, not the label
	}
	u, err := s.svc.SaveUpload(r.Context(), hdr.Filename, mime, data, user(r).Email)
	s.reply(w, r, map[string]any{"ok": true, "url": u}, err)
}

// ---------------------------------------------------------------- staff sign-in

func (s *Server) signInConfig(w http.ResponseWriter, r *http.Request) {
	if s.authMode == "dev" {
		writeJSON(w, 200, map[string]string{"mode": "dev"})
		return
	}
	writeJSON(w, 200, map[string]string{"mode": "keycloak", "issuer": strings.TrimRight(s.realm.Issuer, "/"), "clientId": s.realm.ClientID})
}

type signedInReply struct {
	auth.Tokens
	User User `json:"user"`
}

func (s *Server) signInResult(w http.ResponseWriter, r *http.Request, t auth.Tokens, id auth.Identity, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case err == nil:
		writeJSON(w, 200, signedInReply{t, User{UID: id.UID, Email: id.Email, Name: id.Name, Role: roleOf(id.Access)}})
	case errors.Is(err, auth.ErrNoRole):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, auth.ErrRefused):
		writeError(w, http.StatusUnauthorized, err.Error())
	default:
		s.log.ErrorContext(r.Context(), "staff sign-in failed", "err", err)
		writeError(w, http.StatusBadGateway, "the sign-in service could not be reached; please try again")
	}
}

func (s *Server) signInCode(w http.ResponseWriter, r *http.Request) {
	if s.realm == nil {
		writeError(w, http.StatusNotFound, "single sign-on is not set up")
		return
	}
	var in struct{ Code, CodeVerifier, RedirectURI string }
	if !decode(w, r, &in) {
		return
	}
	u, err := url.Parse(in.RedirectURI)
	if in.Code == "" || in.CodeVerifier == "" || err != nil || u.Host == "" || !slices.Contains(s.allowedOrigins, u.Scheme+"://"+u.Host) {
		writeError(w, http.StatusBadRequest, "code, codeVerifier and an app redirectUri are required")
		return
	}
	t, id, err := s.realm.Exchange(r.Context(), in.Code, in.CodeVerifier, in.RedirectURI)
	s.signInResult(w, r, t, id, err)
}

func (s *Server) signInRefresh(w http.ResponseWriter, r *http.Request) {
	if s.realm == nil {
		writeError(w, http.StatusNotFound, "single sign-on is not set up")
		return
	}
	var in struct{ RefreshToken string }
	if !decode(w, r, &in) {
		return
	}
	if in.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "refreshToken is required")
		return
	}
	t, id, err := s.realm.Refresh(r.Context(), in.RefreshToken)
	s.signInResult(w, r, t, id, err)
}
