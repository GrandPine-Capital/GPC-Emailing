package gmail

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient(t *testing.T) {
	var sentRaw, sentThread string
	refreshes := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			json.NewEncoder(w).Encode(map[string]any{"access_token": "a1", "refresh_token": "r1", "expires_in": 3600, "scope": strings.Join(Scopes, " ")})
		case "refresh_token":
			refreshes++
			if r.Form.Get("refresh_token") != "r1" {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "a2", "expires_in": 3600})
		}
	})
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer a") {
				w.WriteHeader(401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /api/profile", auth(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"emailAddress":"Worker@Example.com"}`))
	}))
	mux.HandleFunc("POST /api/messages/send", auth(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		json.NewDecoder(r.Body).Decode(&b)
		raw, _ := base64.URLEncoding.DecodeString(b["raw"])
		sentRaw, sentThread = string(raw), b["threadId"]
		w.Write([]byte(`{"id":"m1","threadId":"t9"}`))
	}))
	mux.HandleFunc("GET /api/messages/m2", auth(func(w http.ResponseWriter, _ *http.Request) {
		enc := func(s string) string { return base64.URLEncoding.EncodeToString([]byte(s)) }
		json.NewEncoder(w).Encode(map[string]any{"id": "m2", "threadId": "t2", "internalDate": "1762740000000", "payload": map[string]any{
			"mimeType": "multipart/alternative", "headers": []map[string]string{{"name": "From", "value": "A <a@b.co>"}, {"name": "Subject", "value": "Hi"}},
			"parts": []map[string]any{
				{"mimeType": "text/plain", "body": map[string]string{"data": enc("plain body")}},
				{"mimeType": "text/html", "body": map[string]string{"data": enc("<p>html</p>")}},
			}}})
	}))
	mux.HandleFunc("GET /api/settings/sendAs", auth(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"sendAs":[{"sendAsEmail":"Worker@Example.com","isPrimary":true},{"sendAsEmail":"sales@x.com","verificationStatus":"pending"}]}`))
	}))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	o := &OAuth{ClientID: "id", ClientSecret: "secret", RedirectURL: "https://app/cb", TokenURL: srv.URL + "/token", APIBase: srv.URL + "/api"}
	if u := o.AuthURL("st", ""); !strings.Contains(u, "access_type=offline") || !strings.Contains(u, "state=st") {
		t.Errorf("AuthURL %s", u)
	}
	ctx := context.Background()
	c, refresh, err := o.Exchange(ctx, "code")
	if err != nil || refresh != "r1" {
		t.Fatalf("exchange: %v %q", err, refresh)
	}
	if email, err := c.Profile(ctx); err != nil || email != "worker@example.com" {
		t.Fatalf("profile %q %v", email, err)
	}
	id, thread, err := c.Send(ctx, []byte("Subject: x\r\n\r\nbody"), "t1")
	if err != nil || id != "m1" || thread != "t9" || sentThread != "t1" || !strings.Contains(sentRaw, "Subject: x") {
		t.Fatalf("send %q %q %v", id, thread, err)
	}
	m, err := c.Get(ctx, "m2")
	if err != nil || m.Text != "plain body" || m.HTML != "<p>html</p>" || m.Header("from") != "A <a@b.co>" || m.Date.Year() != 2025 {
		t.Fatalf("get %+v %v", m, err)
	}
	list, err := c.SendAsList(ctx)
	if err != nil || len(list) != 2 || !list[0].Verified || list[1].Verified || list[0].Email != "worker@example.com" {
		t.Fatalf("sendAs %+v %v", list, err)
	}
	// A client from a stored refresh token mints its own access token.
	c2 := o.Client("r1")
	if _, err := c2.Profile(ctx); err != nil || refreshes != 1 {
		t.Fatalf("refresh: %v (%d)", err, refreshes)
	}
	if _, err := o.Client("revoked").Profile(ctx); err != ErrRevoked {
		t.Fatalf("revoked token: %v", err)
	}
}
