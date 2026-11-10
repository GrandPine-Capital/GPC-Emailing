package auth

import (
	"context"
	"errors"
	"strings"
)

// DevVerifier accepts tokens of the form "dev:<uid>:<access>" (access admin, editor or
// viewer, the realm's client roles) for local development and tests. Only used when
// AUTH_MODE=dev, which the service refuses in production.
type DevVerifier struct{}

func (DevVerifier) Verify(_ context.Context, token string) (Identity, error) {
	parts := strings.Split(token, ":")
	if len(parts) != 3 || parts[0] != "dev" || parts[1] == "" {
		return Identity{}, errors.New("dev token must look like dev:<uid>:<admin|editor|viewer>")
	}
	a := Access(parts[2])
	if a != AccessAdmin && a != AccessEditor && a != AccessViewer {
		return Identity{}, ErrNoRole
	}
	return Identity{UID: parts[1], Email: parts[1] + "@dev.local", Name: parts[1], Access: a}, nil
}
