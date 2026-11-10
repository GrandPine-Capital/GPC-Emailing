package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// workerLock is the Postgres advisory lock that keeps one tick at a time across every running
// task (a rolling deploy briefly runs two).
const workerLock = 0x6770_656d_6c01 // "gpeml" 1

// Tick runs the worker's steps once within maxDur (tick() in Code.js): campaign and automation
// mail, SES bounces and complaints, replies, automations and the lead finder. Busy when another tick holds the lock.
func (s *Service) Tick(ctx context.Context, maxDur time.Duration) (map[string]any, error) {
	conn, err := s.db.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, workerLock).Scan(&got); err != nil {
		return nil, err
	}
	if !got {
		return map[string]any{"skipped": "busy"}, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, workerLock)
	}()

	end := time.Now().Add(maxDur)
	hasTime := func() bool { return time.Now().Before(end) && ctx.Err() == nil }
	summary := map[string]any{}
	step := func(name string, fn func() (int, error)) {
		if !hasTime() {
			return
		}
		n, err := fn()
		switch {
		case errors.Is(err, ErrNoMailer):
			summary[name] = "sending not set up"
		case err != nil:
			summary[name] = "error: " + err.Error()
			s.log.Error("worker step", "step", name, "err", err)
		default:
			summary[name] = n
		}
	}
	step("transactional", func() (int, error) { return s.processTransactional(ctx, hasTime) })
	step("campaigns", func() (int, error) { return s.processQueue(ctx, hasTime) })
	step("bounces", func() (int, error) { return s.processEvents(ctx, hasTime) })
	step("replies", func() (int, error) { return s.processInbound(ctx, hasTime) })
	step("automations", func() (int, error) { return s.processDue(ctx, hasTime) })
	step("leads", func() (int, error) { return s.processLeads(ctx, hasTime) })
	b, _ := json.Marshal(summary)
	s.noteStatus(ctx, map[string]any{
		"last_tick": s.now().Format(time.RFC3339), "account": s.Account(ctx), "remaining_today": s.RemainingToday(ctx),
		"last_summary": core.Truncate(string(b), 1000),
	})
	return summary, nil
}

// Run ticks every interval, and straight away when woken, until ctx ends.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-s.wake:
			// Let a burst of actions settle into one tick.
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		if summary, err := s.Tick(ctx, 4*time.Minute); err != nil {
			s.log.Error("worker tick", "err", err)
		} else if len(summary) > 0 && summary["skipped"] == nil {
			s.log.Info("worker tick", "summary", summary)
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(interval)
	}
}

func mapNoRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}
