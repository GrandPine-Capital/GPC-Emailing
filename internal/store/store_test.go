package store_test

import (
	"context"
	"testing"

	"github.com/grandpine-capital/gpc-emailing/internal/store"
	"github.com/grandpine-capital/gpc-emailing/internal/testdb"
)

// A migration that adds a column while the service runs must not fail the next read of that
// table (the release still running during a deploy reads tables the new release has changed).
func TestReadsSurviveAMigration(t *testing.T) {
	db, _, _ := testdb.New(t)
	ctx := context.Background()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO lists (id, name) VALUES ('l1', 'L')`); err != nil {
		t.Fatal(err)
	}
	type list struct {
		ID string `db:"id"`
	}
	read := func(when string) {
		t.Helper()
		if rows, err := store.Rows(ctx, db.Pool, `SELECT * FROM lists`); err != nil || len(rows) != 1 {
			t.Fatalf("Rows %s: %v %v", when, rows, err)
		}
		if _, err := store.One(ctx, db.Pool, `SELECT * FROM lists WHERE id = $1`, "l1"); err != nil {
			t.Fatalf("One %s: %v", when, err)
		}
		if l, err := store.Struct[list](ctx, db.Pool, `SELECT * FROM lists WHERE id = $1 LIMIT 1`, "l1"); err != nil || l.ID != "l1" {
			t.Fatalf("Struct %s: %v %v", when, l, err)
		}
		if ls, err := store.Structs[list](ctx, db.Pool, `SELECT * FROM lists ORDER BY id`); err != nil || len(ls) != 1 {
			t.Fatalf("Structs %s: %v %v", when, ls, err)
		}
	}
	read("before")
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE lists ADD COLUMN colour text NOT NULL DEFAULT ''`); err != nil {
		t.Fatal(err)
	}
	read("after the table changed")
	if _, err := store.One(ctx, db.Pool, `SELECT * FROM lists WHERE id = 'none'`); err != store.ErrNotFound {
		t.Fatalf("a missing row: %v", err)
	}
}
