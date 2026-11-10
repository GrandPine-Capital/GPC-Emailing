// Package store is the Postgres connection and a few query helpers. The schema is owned by the
// Flyway migrations in db/migration; this package never creates or alters tables.
package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound = errors.New("not found")
	// ErrConflict is a constraint the database refused (unique key, CHECK, foreign key). The
	// constraint name follows the colon.
	ErrConflict = errors.New("conflict")
)

// Q is what both the pool and a transaction offer.
type Q interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type DB struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*DB, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("store: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: cannot reach database: %w", err)
	}
	return &DB{Pool: pool}, nil
}

func (d *DB) Close()                         { d.Pool.Close() }
func (d *DB) Ping(ctx context.Context) error { return d.Pool.Ping(ctx) }

// InTx runs fn in one transaction.
func (d *DB) InTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, d.Pool, fn)
}

// MapErr turns pgx errors into ErrNotFound / ErrConflict.
func MapErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "23514" || pg.Code == "23503") {
		return fmt.Errorf("%w: %s", ErrConflict, pg.ConstraintName)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// ConstraintOf names the constraint behind an ErrConflict, or "".
func ConstraintOf(err error) string {
	if err == nil {
		return ""
	}
	_, name, _ := strings.Cut(err.Error(), "conflict: ")
	return name
}

// Affected is ErrNotFound when the statement touched no row.
func Affected(tag pgconn.CommandTag, err error) error {
	if err != nil {
		return MapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Row is one result row keyed by column name, ready for JSON: timestamps become RFC 3339 UTC
// strings (what the dashboard compares and formats), dates YYYY-MM-DD.
type Row = map[string]any

func normalise(v any) any {
	switch x := v.(type) {
	case time.Time:
		return x.UTC().Format("2006-01-02T15:04:05.000Z")
	case pgtype.Date:
		if !x.Valid {
			return nil
		}
		return x.Time.Format("2006-01-02")
	case []any:
		for i := range x {
			x[i] = normalise(x[i])
		}
		return x
	case map[string]any:
		for k := range x {
			x[k] = normalise(x[k])
		}
		return x
	}
	return v
}

func toRow(r pgx.CollectableRow) (Row, error) {
	m, err := pgx.RowToMap(r)
	if err != nil {
		return nil, err
	}
	for k, v := range m {
		m[k] = normalise(v)
	}
	return m, nil
}

// Rows runs a query and returns every row as a map (never nil).
func Rows(ctx context.Context, q Q, sql string, args ...any) ([]Row, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, MapErr(err)
	}
	out, err := pgx.CollectRows(rows, toRow)
	if err != nil {
		return nil, MapErr(err)
	}
	if out == nil {
		out = []Row{}
	}
	return out, nil
}

// One runs a query for a single row; ErrNotFound when there is none.
func One(ctx context.Context, q Q, sql string, args ...any) (Row, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, MapErr(err)
	}
	r, err := pgx.CollectExactlyOneRow(rows, toRow)
	if err != nil {
		return nil, MapErr(err)
	}
	return r, nil
}

// scanStruct scans a row into T by `db` tags. Columns without a field are skipped, fields
// without a column keep their zero value, so SELECT * keeps working as columns are added.
func scanStruct[T any](row pgx.CollectableRow) (T, error) {
	var v T
	rv := reflect.ValueOf(&v).Elem()
	byName := map[string]int{}
	for i := 0; i < rv.NumField(); i++ {
		if tag := rv.Type().Field(i).Tag.Get("db"); tag != "" && tag != "-" {
			byName[tag] = i
		}
	}
	fields := row.FieldDescriptions()
	dest := make([]any, len(fields))
	for i, f := range fields {
		if idx, ok := byName[f.Name]; ok {
			dest[i] = rv.Field(idx).Addr().Interface()
		} else {
			dest[i] = new(any)
		}
	}
	return v, row.Scan(dest...)
}

// Structs runs a query into structs matched by `db` column names.
func Structs[T any](ctx context.Context, q Q, sql string, args ...any) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, MapErr(err)
	}
	out, err := pgx.CollectRows(rows, scanStruct[T])
	if err != nil {
		return nil, MapErr(err)
	}
	return out, nil
}

// Struct runs a query for one struct; ErrNotFound when there is none.
func Struct[T any](ctx context.Context, q Q, sql string, args ...any) (T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		var zero T
		return zero, MapErr(err)
	}
	v, err := pgx.CollectExactlyOneRow(rows, scanStruct[T])
	return v, MapErr(err)
}

// Count runs a SELECT count(*).
func Count(ctx context.Context, q Q, sql string, args ...any) (int, error) {
	var n int
	err := q.QueryRow(ctx, sql, args...).Scan(&n)
	return n, MapErr(err)
}
