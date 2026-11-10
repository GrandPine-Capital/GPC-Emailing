// Package ids mints random 20-character document ids; every record looks alike and
// stays unguessable.
package ids

import (
	"crypto/rand"
	"math/big"
)

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// New returns a random 20-character alphanumeric id.
func New() string {
	b := make([]byte, 20)
	max := big.NewInt(int64(len(alphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic("ids: crypto/rand unavailable: " + err.Error())
		}
		b[i] = alphabet[n.Int64()]
	}
	return string(b)
}

// Valid reports whether s could be a record id.
func Valid(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// Token returns a random 24-character lower-case hex token: the id of a message, carried in its
// open, click and unsubscribe links (the format the Firebase build used).
func Token() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("ids: crypto/rand unavailable: " + err.Error())
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 24)
	for i, v := range b {
		out[i*2], out[i*2+1] = hex[v>>4], hex[v&0x0f]
	}
	return string(out)
}

// IsToken reports whether s looks like a message token.
func IsToken(s string) bool {
	if len(s) != 24 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
