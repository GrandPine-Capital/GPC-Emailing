// Package testdb gives integration tests a fresh database with the Flyway migrations applied
// in version order, the same files Flyway runs in deployment.
package testdb

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/secretbox"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// New creates a throwaway database with the migrations applied and returns it, with a fresh
// SETTINGS_ENCRYPTION_KEY and its box. Set TEST_DATABASE_URL to a server where the user may
// CREATE DATABASE; without one the test is skipped.
func New(t *testing.T) (*store.DB, *secretbox.Box, string) {
	t.Helper()
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set — skipping Postgres integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Skipf("Postgres unavailable: %v", err)
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	name := "gpc_emailing_test_" + hex.EncodeToString(suffix)
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		conn.Close(context.Background())
	})

	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	migrate(t, u.String())

	key := make([]byte, 32)
	_, _ = rand.Read(key)
	b64 := base64.StdEncoding.EncodeToString(key)
	box, err := secretbox.New(b64)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db, box, b64
}

var versioned = regexp.MustCompile(`^V(\d+)__.+\.sql$`)

func migrate(t *testing.T, dsn string) {
	t.Helper()
	dir := migrationDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	type mig struct {
		v    int
		path string
	}
	var migs []mig
	for _, e := range entries {
		if m := versioned.FindStringSubmatch(e.Name()); m != nil {
			v, _ := strconv.Atoi(m[1])
			migs = append(migs, mig{v, filepath.Join(dir, e.Name())})
		}
	}
	sort.Slice(migs, func(i, j int) bool { return migs[i].v < migs[j].v })
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, m := range migs {
		sql, err := os.ReadFile(m.path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.PgConn().Exec(ctx, string(sql)).ReadAll(); err != nil {
			t.Fatalf("migration %s: %v", filepath.Base(m.path), err)
		}
	}
}

func migrationDir(t *testing.T) string {
	dir, _ := os.Getwd()
	for {
		if b, err := os.ReadFile(filepath.Join(dir, "go.mod")); err == nil && bytes.Contains(b, []byte("gpc-emailing")) {
			return filepath.Join(dir, "db", "migration")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal(fmt.Errorf("cannot find repository root"))
		}
		dir = parent
	}
}
