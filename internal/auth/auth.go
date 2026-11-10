// Package auth identifies who is calling: staff through the GrandPine staff realm
// (keycloak.go) and, locally, dev tokens (dev.go).
package auth

import (
	"context"
	"errors"
	"strings"
)

// Access is the staff realm's client role: the access level IAM grants on this app.
type Access string

const (
	AccessAdmin  Access = "admin"
	AccessEditor Access = "editor"
	AccessViewer Access = "viewer"
)

// Identity is who a valid staff token belongs to.
type Identity struct {
	UID    string
	Email  string
	Name   string
	Access Access
}

var (
	ErrNoToken = errors.New("missing bearer token")
	// ErrNoRole is a valid sign-in by someone who holds no role on this app's client.
	ErrNoRole = errors.New("no role on Emailing: ask an IAM administrator for access")
	// ErrRefused is the realm refusing a code or a refresh token.
	ErrRefused = errors.New("the sign-in has expired: please sign in again")
)

// StaffVerifier turns a staff bearer token into an identity.
type StaffVerifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// BearerToken extracts the token from an Authorization header.
func BearerToken(header string) (string, error) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
		return "", ErrNoToken
	}
	return strings.TrimSpace(token), nil
}
