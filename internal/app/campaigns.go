package app

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// launch queues a message for every subscribed contact on the campaign's lists (once per
// contact, across lists and relaunches) and marks the campaign sending (Campaigns.launch).
func (s *Service) launch(ctx context.Context, c Campaign) (int, error) {
	if c.TemplateID == nil || *c.TemplateID == "" {
		_, err := s.db.Pool.Exec(ctx, `UPDATE campaigns SET status = 'draft', error = 'Choose a template first' WHERE id = $1`, c.ID)
		return 0, err
	}
	n := 0
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		recipients, err := store.Structs[Contact](ctx, tx, `SELECT * FROM contacts c WHERE c.list_ids && $2 AND c.status = 'subscribed'
			AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = $1 AND m.contact_id = c.id) ORDER BY c.created_at`, c.ID, c.ListIDs)
		if err != nil {
			return err
		}
		for i := range recipients {
			if !core.IsEmail(recipients[i].Email) {
				continue
			}
			if _, err := s.insertMessage(ctx, tx, newMessage{Contact: &recipients[i], TemplateID: *c.TemplateID, Subject: c.Subject, CampaignID: c.ID, CampaignName: c.Name}); err != nil {
				return err
			}
			n++
		}
		_, err = tx.Exec(ctx, `UPDATE campaigns SET status = 'sending', started_at = coalesce(started_at, $2), error = NULL,
			stat_total = stat_total + $3, stat_queued = stat_queued + $3 WHERE id = $1`, c.ID, s.now(), n)
		return err
	})
	return n, err
}

// startDue launches campaigns the user started or whose schedule has come.
func (s *Service) startDue(ctx context.Context) (int, error) {
	due, err := store.Structs[Campaign](ctx, s.db.Pool, `SELECT * FROM campaigns WHERE status = 'launching'
		OR (status = 'scheduled' AND scheduled_at <= $1) ORDER BY created_at`, s.now())
	if err != nil {
		return 0, err
	}
	for _, c := range due {
		if _, err := s.launch(ctx, c); err != nil {
			s.log.Error("campaign launch", "campaign", c.ID, "err", err)
		}
	}
	return len(due), nil
}

// processQueue sends queued messages within the per-run and daily limits, then marks finished
// campaigns sent (Campaigns.processQueue).
func (s *Service) processQueue(ctx context.Context, hasTime func() bool) (int, error) {
	if _, err := s.startDue(ctx); err != nil {
		return 0, err
	}
	if err := s.canSend(ctx); err != nil {
		return 0, err
	}
	perRun := s.Settings(ctx).PerRunLimit
	if perRun <= 0 {
		perRun = 40
	}
	budget := min(perRun, s.RemainingToday(ctx))
	sent := 0
	if budget > 0 {
		// Messages of paused (or deleted) campaigns wait; automation mail has no campaign.
		queued, err := store.Structs[struct {
			ID string `db:"id"`
		}](ctx, s.db.Pool, `SELECT m.id FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id
			WHERE m.status = 'queued' AND (m.campaign_id IS NULL OR c.status = 'sending') ORDER BY m.created_at LIMIT $1`, budget)
		if err != nil {
			return 0, err
		}
		for _, q := range queued {
			if budget <= 0 || !hasTime() {
				break
			}
			status, err := s.deliver(ctx, q.ID, threadOpts{})
			if status == "sent" {
				sent++
			} else if err != nil {
				s.log.Info("message not sent", "message", q.ID, "status", status, "err", err)
			}
			budget--
		}
	}
	_, err := s.db.Pool.Exec(ctx, `UPDATE campaigns c SET status = 'sent', finished_at = $1 WHERE status = 'sending'
		AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = c.id AND m.status = 'queued')`, s.now())
	return sent, err
}
