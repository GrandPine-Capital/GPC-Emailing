// Package gmail talks to the Gmail API for one connected mailbox: it sends the raw MIME the
// service builds (so List-Unsubscribe and threading headers survive), reads the inbox for
// replies, bounces and auto-reply rules, and lists the mailbox's "Send mail as" addresses.
//
// An administrator connects the mailbox once (Settings → Gmail) through Google's OAuth consent
// screen; the service keeps the refresh token, sealed, and mints access tokens from it.
package gmail

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Scopes: send, read the inbox, and read the Send-mail-as settings. Nothing that deletes.
var Scopes = []string{
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.settings.basic",
}

const (
	authEndpoint  = "https://accounts.google.com/o/oauth2/v2/auth"
	tokenEndpoint = "https://oauth2.googleapis.com/token"
	apiBase       = "https://gmail.googleapis.com/gmail/v1/users/me"
)

// ErrRevoked is Google refusing the refresh token: the mailbox must be connected again.
var ErrRevoked = errors.New("the Gmail connection was revoked or has expired: an administrator must connect Gmail again in Settings")

// OAuth is the Google OAuth client the mailbox is connected through.
type OAuth struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string // <PUBLIC_BASE_URL>/oauth/google/callback
	HTTP         *http.Client
	// TokenURL and APIBase override Google's endpoints in tests.
	TokenURL string
	APIBase  string
}

func (o *OAuth) client() *http.Client {
	if o.HTTP != nil {
		return o.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (o *OAuth) tokenURL() string {
	if o.TokenURL != "" {
		return o.TokenURL
	}
	return tokenEndpoint
}

func (o *OAuth) api() string {
	if o.APIBase != "" {
		return o.APIBase
	}
	return apiBase
}

// Configured reports whether a Google client is set up at all.
func (o *OAuth) Configured() bool { return o != nil && o.ClientID != "" && o.ClientSecret != "" }

// AuthURL is Google's consent page. access_type=offline + prompt=consent make Google return a
// refresh token every time, also when the mailbox was connected before.
func (o *OAuth) AuthURL(state, loginHint string) string {
	q := url.Values{
		"client_id":              {o.ClientID},
		"redirect_uri":           {o.RedirectURL},
		"response_type":          {"code"},
		"scope":                  {strings.Join(Scopes, " ")},
		"access_type":            {"offline"},
		"prompt":                 {"consent"},
		"include_granted_scopes": {"true"},
		"state":                  {state},
	}
	if loginHint != "" {
		q.Set("login_hint", loginHint)
	}
	return authEndpoint + "?" + q.Encode()
}

type tokenReply struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

func (o *OAuth) token(ctx context.Context, form url.Values) (tokenReply, error) {
	form.Set("client_id", o.ClientID)
	form.Set("client_secret", o.ClientSecret)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.tokenURL(), strings.NewReader(form.Encode()))
	if err != nil {
		return tokenReply{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := o.client().Do(req)
	if err != nil {
		return tokenReply{}, fmt.Errorf("google token endpoint: %w", err)
	}
	defer res.Body.Close()
	var t tokenReply
	_ = json.NewDecoder(res.Body).Decode(&t)
	if t.Error == "invalid_grant" {
		return t, ErrRevoked
	}
	if res.StatusCode != http.StatusOK || t.AccessToken == "" {
		return t, fmt.Errorf("google token endpoint answered %d %s %s", res.StatusCode, t.Error, t.Description)
	}
	return t, nil
}

// Exchange finishes the consent flow. It returns a client for the mailbox and its refresh token.
func (o *OAuth) Exchange(ctx context.Context, code string) (*Client, string, error) {
	t, err := o.token(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {o.RedirectURL}})
	if err != nil {
		return nil, "", err
	}
	if t.RefreshToken == "" {
		return nil, "", errors.New("google returned no refresh token: remove the app's access at myaccount.google.com/permissions and connect again")
	}
	for _, s := range Scopes {
		if !strings.Contains(" "+t.Scope+" ", " "+s+" ") {
			return nil, "", fmt.Errorf("google did not grant %s: tick every permission on the consent screen", s)
		}
	}
	c := o.Client(t.RefreshToken)
	c.access, c.expiry = t.AccessToken, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second)
	return c, t.RefreshToken, nil
}

// Client calls the Gmail API for one mailbox.
type Client struct {
	o       *OAuth
	refresh string

	mu     sync.Mutex
	access string
	expiry time.Time
}

func (o *OAuth) Client(refreshToken string) *Client { return &Client{o: o, refresh: refreshToken} }

func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.access != "" && time.Until(c.expiry) > time.Minute {
		return c.access, nil
	}
	t, err := c.o.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.refresh}})
	if err != nil {
		return "", err
	}
	c.access, c.expiry = t.AccessToken, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second)
	return c.access, nil
}

// APIError is a Gmail API error answer.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("Gmail API %d: %s", e.Status, e.Message) }

func (c *Client) call(ctx context.Context, method, path string, body any, out any) error {
	token, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.o.api()+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.o.client().Do(req)
	if err != nil {
		return fmt.Errorf("gmail: %w", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 40<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		msg := e.Error.Message
		if msg == "" {
			msg = strings.TrimSpace(string(data[:min(len(data), 300)]))
		}
		return &APIError{Status: res.StatusCode, Message: msg}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Profile is the connected mailbox's address.
func (c *Client) Profile(ctx context.Context) (string, error) {
	var p struct {
		EmailAddress string `json:"emailAddress"`
	}
	if err := c.call(ctx, http.MethodGet, "/profile", nil, &p); err != nil {
		return "", err
	}
	return strings.ToLower(p.EmailAddress), nil
}

// Send sends a raw RFC 2822 message, in threadID's conversation when given.
func (c *Client) Send(ctx context.Context, raw []byte, threadID string) (id, thread string, err error) {
	body := map[string]string{"raw": base64.URLEncoding.EncodeToString(raw)}
	if threadID != "" {
		body["threadId"] = threadID
	}
	var out struct{ ID, ThreadID string }
	if err := c.call(ctx, http.MethodPost, "/messages/send", body, &out); err != nil {
		return "", "", err
	}
	return out.ID, out.ThreadID, nil
}

// Ref is a message id from a search.
type Ref struct {
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
}

// List searches the mailbox (Gmail search syntax), newest first, up to max messages.
func (c *Client) List(ctx context.Context, query string, max int) ([]Ref, error) {
	var out []Ref
	page := ""
	for len(out) < max {
		q := url.Values{"q": {query}, "maxResults": {strconv.Itoa(min(500, max-len(out)))}}
		if page != "" {
			q.Set("pageToken", page)
		}
		var res struct {
			Messages      []Ref  `json:"messages"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := c.call(ctx, http.MethodGet, "/messages?"+q.Encode(), nil, &res); err != nil {
			return nil, err
		}
		out = append(out, res.Messages...)
		if res.NextPageToken == "" {
			break
		}
		page = res.NextPageToken
	}
	return out, nil
}

// Message is a message read from the mailbox.
type Message struct {
	ID       string
	ThreadID string
	Date     time.Time
	headers  map[string][]string
	Text     string // the text/plain body, or the HTML body as text
	HTML     string
}

// Header is the first value of a header ("" when absent).
func (m *Message) Header(name string) string {
	if v := m.headers[strings.ToLower(name)]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// NewMessage builds a Message (for tests and fakes).
func NewMessage(id, thread string, date time.Time, headers map[string]string, text string) *Message {
	m := &Message{ID: id, ThreadID: thread, Date: date, Text: text, headers: map[string][]string{}}
	for k, v := range headers {
		m.headers[strings.ToLower(k)] = []string{v}
	}
	return m
}

type part struct {
	MimeType string `json:"mimeType"`
	Headers  []struct{ Name, Value string }
	Body     struct {
		Data string `json:"data"`
	} `json:"body"`
	Parts []part `json:"parts"`
}

// Get reads one message in full.
func (c *Client) Get(ctx context.Context, id string) (*Message, error) {
	var res struct {
		ID           string `json:"id"`
		ThreadID     string `json:"threadId"`
		InternalDate string `json:"internalDate"`
		Payload      part   `json:"payload"`
	}
	if err := c.call(ctx, http.MethodGet, "/messages/"+url.PathEscape(id)+"?format=full", nil, &res); err != nil {
		return nil, err
	}
	ms, _ := strconv.ParseInt(res.InternalDate, 10, 64)
	m := &Message{ID: res.ID, ThreadID: res.ThreadID, Date: time.UnixMilli(ms).UTC(), headers: map[string][]string{}}
	for _, h := range res.Payload.Headers {
		k := strings.ToLower(h.Name)
		m.headers[k] = append(m.headers[k], h.Value)
	}
	var walk func(p part)
	walk = func(p part) {
		switch {
		case strings.HasPrefix(p.MimeType, "multipart/"):
			for _, sub := range p.Parts {
				walk(sub)
			}
		case p.MimeType == "text/plain" && m.Text == "":
			m.Text = decodeBody(p.Body.Data)
		case p.MimeType == "text/html" && m.HTML == "":
			m.HTML = decodeBody(p.Body.Data)
		case p.MimeType == "message/delivery-status" || p.MimeType == "message/rfc822":
			// Bounce reports carry Final-Recipient here; keep it readable.
			m.Text += "\n" + decodeBody(p.Body.Data)
			for _, sub := range p.Parts {
				walk(sub)
			}
		}
	}
	walk(res.Payload)
	return m, nil
}

func decodeBody(s string) string {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		b, _ = base64.RawURLEncoding.DecodeString(s)
	}
	return string(b)
}

// MessageIDHeader is the RFC Message-ID of a sent message (needed to thread a follow-up).
func (c *Client) MessageIDHeader(ctx context.Context, id string) (string, error) {
	var res struct {
		Payload part `json:"payload"`
	}
	if err := c.call(ctx, http.MethodGet, "/messages/"+url.PathEscape(id)+"?format=metadata&metadataHeaders=Message-ID", nil, &res); err != nil {
		return "", err
	}
	for _, h := range res.Payload.Headers {
		if strings.EqualFold(h.Name, "Message-ID") {
			return h.Value, nil
		}
	}
	return "", nil
}

// SendAs is a "Send mail as" address of the mailbox.
type SendAs struct {
	Email     string `json:"email"`
	Name      string `json:"name"`
	Primary   bool   `json:"primary"`
	IsDefault bool   `json:"is_default"`
	Verified  bool   `json:"verified"`
}

func (c *Client) SendAsList(ctx context.Context) ([]SendAs, error) {
	var res struct {
		SendAs []struct {
			SendAsEmail        string `json:"sendAsEmail"`
			DisplayName        string `json:"displayName"`
			IsPrimary          bool   `json:"isPrimary"`
			IsDefault          bool   `json:"isDefault"`
			VerificationStatus string `json:"verificationStatus"`
		} `json:"sendAs"`
	}
	if err := c.call(ctx, http.MethodGet, "/settings/sendAs", nil, &res); err != nil {
		return nil, err
	}
	out := []SendAs{}
	for _, s := range res.SendAs {
		out = append(out, SendAs{
			Email: strings.ToLower(s.SendAsEmail), Name: s.DisplayName, Primary: s.IsPrimary, IsDefault: s.IsDefault,
			Verified: s.IsPrimary || s.VerificationStatus == "accepted",
		})
	}
	return out, nil
}
