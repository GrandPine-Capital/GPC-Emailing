// Package httpapi exposes the service over HTTP: the dashboard's API under /api, the public
// routes e-mails and other apps reach (open pixel, click redirect, unsubscribe, webhooks,
// images), and the dashboard itself.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/auth"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

type Server struct {
	svc            *app.Service
	staff          auth.StaffVerifier
	realm          *auth.Keycloak
	authMode       string
	allowedOrigins []string
	log            *slog.Logger
}

type Deps struct {
	Service *app.Service
	// Staff verifies bearer tokens; Realm, when set, is the staff realm client the sign-in
	// routes exchange codes with (AUTH_MODE=keycloak).
	Staff          auth.StaffVerifier
	Realm          *auth.Keycloak
	AuthMode       string
	AllowedOrigins []string
	Log            *slog.Logger
	// UI serves the dashboard for every other path.
	UI http.Handler
}

func New(d Deps) http.Handler {
	s := &Server{svc: d.Service, staff: d.Staff, realm: d.Realm, authMode: d.AuthMode, allowedOrigins: d.AllowedOrigins, log: d.Log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /readyz", s.ready)
	s.public(mux)
	s.routes(mux)
	if d.UI != nil {
		mux.Handle("/", d.UI)
	}
	return s.recoverer(s.logRequests(s.cors(mux)))
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DB().Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database unavailable"})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ready"})
}

// User is the signed-in person. Role is what the dashboard knows: admin (settings), member
// (day-to-day work) or viewer (read-only), from the realm's admin / editor / viewer.
type User struct {
	UID   string `json:"uid"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

func (u User) IsAdmin() bool  { return u.Role == "admin" }
func (u User) CanWrite() bool { return u.Role != "viewer" }

func roleOf(a auth.Access) string {
	switch a {
	case auth.AccessAdmin:
		return "admin"
	case auth.AccessEditor:
		return "member"
	}
	return "viewer"
}

type ctxKey struct{}

func user(r *http.Request) User {
	u, _ := r.Context().Value(ctxKey{}).(User)
	return u
}

// signedIn authenticates the caller and refuses writes from viewers before any handler runs.
func (s *Server) signedIn(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, err := auth.BearerToken(r.Header.Get("Authorization"))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		id, err := s.staff.Verify(r.Context(), token)
		if errors.Is(err, auth.ErrNoRole) {
			writeError(w, http.StatusForbidden, err.Error())
			return
		}
		if err != nil {
			s.log.InfoContext(r.Context(), "staff auth rejected", "err", err)
			writeError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		u := User{UID: id.UID, Email: id.Email, Name: id.Name, Role: roleOf(id.Access)}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !u.CanWrite() {
			writeError(w, http.StatusForbidden, "Your access to Emailing is read-only.")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

// admin is signedIn for administrators only.
func (s *Server) admin(h http.HandlerFunc) http.Handler {
	return s.signedIn(func(w http.ResponseWriter, r *http.Request) {
		if !user(r).IsAdmin() {
			writeError(w, http.StatusForbidden, "Only admins can change this")
			return
		}
		h(w, r)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if strings.HasPrefix(r.URL.Path, "/api/") && origin != "" && slices.Contains(s.allowedOrigins, origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/hook" {
			return
		}
		s.log.InfoContext(r.Context(), "request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.log.ErrorContext(r.Context(), "panic", "value", fmt.Sprint(v), "path", r.URL.Path)
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

const maxBody = 2 << 20

func decodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool { return decodeLimit(w, r, v, maxBody) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail maps a service error onto an HTTP response.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ue app.UserError
	var fe app.ErrForbidden
	switch {
	case errors.As(err, &ue):
		writeError(w, http.StatusBadRequest, ue.Msg)
	case errors.As(err, &fe):
		writeError(w, http.StatusForbidden, fe.Msg)
	case errors.Is(err, app.ErrNoMailer):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrConflict):
		s.log.WarnContext(r.Context(), "constraint refused the request", "err", err, "path", r.URL.Path)
		writeError(w, http.StatusConflict, "The database refused that change: "+store.ConstraintOf(err))
	default:
		s.log.ErrorContext(r.Context(), "request failed", "err", err, "path", r.URL.Path)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// reply writes v, or maps err.
func (s *Server) reply(w http.ResponseWriter, r *http.Request, v any, err error) {
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

var ok = map[string]bool{"ok": true}
