package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

// Keycloak signs staff in through the GrandPine staff realm (gpc-staff), the same single sign-on as
// the CRM, Studio and the payment apps. The realm decides who the person is (the subject) and the
// access level here: the Emailing client's role in the access token (admin, editor or viewer),
// granted in the IAM console (gpc-auth), never in this service. No role, no way in.
//
// The client is confidential, as every app client in the realm is (ValueFarm.Infra
// iam/modules/staff-realm): the app runs the authorization-code + PKCE redirect in the browser and
// hands the code to this service, which exchanges it with the client secret. The app then sends the
// access token as its bearer token, and each request is checked against the realm's signing keys
// (RS256, iss, aud, exp) — nothing is looked up per request. Access tokens live five minutes; the
// app renews them through Refresh, so disabling someone in IAM ends their access within that.
type Keycloak struct {
	Issuer       string // https://vf-iam-prod.grandpine.com/realms/gpc-staff
	ClientID     string
	ClientSecret string
	// IdentityOnly is the customer realm: who the person is, no role required (and a public
	// client\'s token may name this client as azp rather than in aud).
	IdentityOnly bool
	HTTP         *http.Client

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// KeysTTL is how long the realm's signing keys are trusted before they are read again. An unknown
// key id is fetched straight away (the realm rotated), at most once a minute.
const KeysTTL = 10 * time.Minute

// accessPrecedence decides the access of someone the realm grants several: the most capable wins.
var accessPrecedence = []Access{AccessAdmin, AccessEditor, AccessViewer}

type keycloakClaims struct {
	jwt.RegisteredClaims
	Email             string `json:"email"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	AZP               string `json:"azp"`
	ResourceAccess    map[string]struct {
		Roles []string `json:"roles"`
	} `json:"resource_access"`
}

func (k *Keycloak) client() *http.Client {
	if k.HTTP != nil {
		return k.HTTP
	}
	return &http.Client{Timeout: 5 * time.Second}
}

func (k *Keycloak) issuer() string { return strings.TrimRight(k.Issuer, "/") }

func (k *Keycloak) endpoint(name string) string {
	return k.issuer() + "/protocol/openid-connect/" + name
}

// accessFor is the access level carried by the claims for this client, or "" for none.
func (k *Keycloak) accessFor(c *keycloakClaims) Access {
	held := c.ResourceAccess[k.ClientID].Roles
	for _, a := range accessPrecedence {
		if slices.Contains(held, string(a)) {
			return a
		}
	}
	return ""
}

func (k *Keycloak) signingKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if key, ok := k.keys[kid]; ok && time.Since(k.fetchedAt) < KeysTTL {
		return key, nil
	}
	if k.keys != nil && time.Since(k.fetchedAt) < time.Minute {
		if key, ok := k.keys[kid]; ok {
			return key, nil
		}
		return nil, fmt.Errorf("no realm key %q", kid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.endpoint("certs"), nil)
	if err != nil {
		return nil, err
	}
	res, err := k.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("realm keys: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("realm keys: HTTP %d", res.StatusCode)
	}
	var set struct {
		Keys []struct{ Kid, Kty, Use, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&set); err != nil {
		return nil, fmt.Errorf("realm keys: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, jk := range set.Keys {
		if jk.Kty != "RSA" || (jk.Use != "" && jk.Use != "sig") {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(jk.N)
		e, errE := base64.RawURLEncoding.DecodeString(jk.E)
		if errN != nil || errE != nil {
			continue
		}
		keys[jk.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	k.keys, k.fetchedAt = keys, time.Now()
	key, ok := keys[kid]
	if !ok {
		return nil, fmt.Errorf("no realm key %q", kid)
	}
	return key, nil
}

func (k *Keycloak) parse(ctx context.Context, raw string) (*keycloakClaims, error) {
	c := &keycloakClaims{}
	_, err := jwt.ParseWithClaims(raw, c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return k.signingKey(ctx, kid)
	}, jwt.WithValidMethods([]string{"RS256"}))
	switch {
	case err != nil:
		return nil, fmt.Errorf("invalid token: %w", err)
	case c.Issuer != k.issuer():
		return nil, fmt.Errorf("issuer %q is not the staff realm", c.Issuer)
	case !c.VerifyAudience(k.ClientID, true) && !(k.IdentityOnly && c.AZP == k.ClientID):
		return nil, fmt.Errorf("token is not for client %q", k.ClientID)
	case c.Subject == "":
		return nil, errors.New("token has no subject")
	}
	return c, nil
}

func identityOf(c *keycloakClaims) Identity {
	name := strings.TrimSpace(c.Name)
	if name == "" {
		name = c.PreferredUsername
	}
	return Identity{UID: c.Subject, Email: strings.ToLower(strings.TrimSpace(c.Email)), Name: name}
}

func (k *Keycloak) Verify(ctx context.Context, token string) (Identity, error) {
	c, err := k.parse(ctx, token)
	if err != nil {
		return Identity{}, err
	}
	id := identityOf(c)
	if k.IdentityOnly {
		return id, nil
	}
	a := k.accessFor(c)
	if a == "" {
		return Identity{}, ErrNoRole
	}
	id.Access = a
	return id, nil
}

// Tokens are what the app keeps for a signed-in person.
type Tokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	// IDToken is the hint for single sign-out (the realm's end-session endpoint).
	IDToken   string `json:"idToken,omitempty"`
	ExpiresIn int    `json:"expiresIn"`
}

func (k *Keycloak) token(ctx context.Context, form url.Values) (Tokens, Identity, error) {
	form.Set("client_id", k.ClientID)
	if k.ClientSecret != "" { // a public client (PKCE only) has none
		form.Set("client_secret", k.ClientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.endpoint("token"), strings.NewReader(form.Encode()))
	if err != nil {
		return Tokens{}, Identity{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := k.client().Do(req)
	if err != nil {
		return Tokens{}, Identity{}, fmt.Errorf("realm token endpoint: %w", err)
	}
	defer res.Body.Close()
	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
		Description  string `json:"error_description"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	if body.Error == "invalid_grant" {
		return Tokens{}, Identity{}, ErrRefused
	}
	if res.StatusCode != http.StatusOK || body.AccessToken == "" {
		return Tokens{}, Identity{}, fmt.Errorf("realm token endpoint answered %d %s %s", res.StatusCode, body.Error, body.Description)
	}
	p, err := k.Verify(ctx, body.AccessToken)
	if err != nil {
		return Tokens{}, Identity{}, err
	}
	t := Tokens{AccessToken: body.AccessToken, RefreshToken: body.RefreshToken, IDToken: body.IDToken, ExpiresIn: body.ExpiresIn}
	if t.RefreshToken == "" {
		t.RefreshToken = form.Get("refresh_token")
	}
	return t, p, nil
}

// Exchange finishes the authorization-code + PKCE sign-in the app started.
func (k *Keycloak) Exchange(ctx context.Context, code, codeVerifier, redirectURI string) (Tokens, Identity, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI}}
	if codeVerifier != "" {
		form.Set("code_verifier", codeVerifier)
	}
	return k.token(ctx, form)
}

// Refresh renews the access token. The realm's answer decides whether the session goes on.
func (k *Keycloak) Refresh(ctx context.Context, refreshToken string) (Tokens, Identity, error) {
	return k.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}})
}
