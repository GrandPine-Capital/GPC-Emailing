package app

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Opens (the pixel), clicks (the redirect) and unsubscribes are recorded as they happen, by the
// public routes: the Firebase build queued clicks and unsubscribes in Firestore for the worker.

func (s *Service) messageByToken(ctx context.Context, token string) (*Message, error) {
	if !ids.IsToken(token) {
		return nil, store.ErrNotFound
	}
	m, err := store.Struct[Message](ctx, s.db.Pool, `SELECT * FROM messages WHERE id = $1`, token)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// markOpened counts an open; the first one also counts for the campaign and fires email_opened.
func (s *Service) markOpened(ctx context.Context, m *Message) error {
	var first bool
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		var err error
		if first, err = firstTime(ctx, tx, "opened_at", m.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE messages SET open_count = open_count + 1, opened_at = coalesce(opened_at, $2) WHERE id = $1`, m.ID, s.now()); err != nil {
			return err
		}
		if first && m.CampaignID != nil {
			_, err = tx.Exec(ctx, `UPDATE campaigns SET stat_opened = stat_opened + 1 WHERE id = $1`, *m.CampaignID)
		}
		return err
	})
	if err != nil || !first {
		return err
	}
	now := s.now()
	m.OpenedAt = &now
	s.bumpDaily(ctx, s.db.Pool, "opens", 1)
	s.Fire(ctx, "email_opened", Event{ContactID: m.ContactID, CampaignID: deref(m.CampaignID), TemplateID: deref(m.TemplateID), MessageID: m.ID})
	return nil
}

// firstTime locks the message and reports whether col (opened_at, clicked_at, replied_at) is
// still unset, so concurrent hits count the first one exactly once.
func firstTime(ctx context.Context, tx pgx.Tx, col, id string) (bool, error) {
	var prev *time.Time
	// col is one of three fixed names.
	if err := tx.QueryRow(ctx, `SELECT `+col+` FROM messages WHERE id = $1 FOR UPDATE`, id).Scan(&prev); err != nil {
		return false, err
	}
	return prev == nil, nil
}

// Open records the open pixel. Unknown tokens are ignored.
func (s *Service) Open(ctx context.Context, token string) error {
	m, err := s.messageByToken(ctx, token)
	if IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.markOpened(ctx, m)
}

// Click records a click and returns where to send the browser ("" for an unknown link).
func (s *Service) Click(ctx context.Context, token, key string) (string, error) {
	var url string
	err := s.db.Pool.QueryRow(ctx, `SELECT url FROM links WHERE key = $1`, key).Scan(&url)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	m, err := s.messageByToken(ctx, token)
	if IsNotFound(err) {
		return url, nil // a link from a deleted campaign still works
	} else if err != nil {
		return url, err
	}
	if m.OpenedAt == nil { // a click implies an open (images may be blocked)
		if err := s.markOpened(ctx, m); err != nil {
			return url, err
		}
	}
	var first bool
	err = s.db.InTx(ctx, func(tx pgx.Tx) error {
		var err error
		if first, err = firstTime(ctx, tx, "clicked_at", m.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE messages SET click_count = click_count + 1, clicked_at = coalesce(clicked_at, $2) WHERE id = $1`, m.ID, s.now()); err != nil {
			return err
		}
		if m.CampaignID == nil {
			return nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO campaign_links (campaign_id, link_key, url, clicks) VALUES ($1, $2, $3, 1)
			ON CONFLICT (campaign_id, link_key) DO UPDATE SET clicks = campaign_links.clicks + 1`, *m.CampaignID, key, url); err != nil {
			return err
		}
		if first {
			_, err := tx.Exec(ctx, `UPDATE campaigns SET stat_clicked = stat_clicked + 1 WHERE id = $1`, *m.CampaignID)
			return err
		}
		return nil
	})
	if err != nil {
		return url, err
	}
	s.bumpDaily(ctx, s.db.Pool, "clicks", 1)
	s.Fire(ctx, "link_clicked", Event{ContactID: m.ContactID, CampaignID: deref(m.CampaignID), TemplateID: deref(m.TemplateID), MessageID: m.ID, URL: url})
	return url, nil
}

// UnsubscribeContact unsubscribes a contact, stops their automations and fires unsubscribed.
// False when they were already unsubscribed (or unknown).
func (s *Service) UnsubscribeContact(ctx context.Context, contactID string, m *Message) (bool, error) {
	var changed bool
	err := s.db.InTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = $2 WHERE id = $1 AND status <> 'unsubscribed'`, contactID, s.now())
		if err != nil {
			return err
		}
		changed = tag.RowsAffected() > 0
		if changed && m != nil && m.CampaignID != nil {
			_, err = tx.Exec(ctx, `UPDATE campaigns SET stat_unsubscribed = stat_unsubscribed + 1 WHERE id = $1`, *m.CampaignID)
		}
		return err
	})
	if err != nil || !changed {
		return false, err
	}
	s.stopRunsFor(ctx, contactID)
	ev := Event{ContactID: contactID}
	if m != nil {
		ev.CampaignID, ev.MessageID = deref(m.CampaignID), m.ID
	}
	s.Fire(ctx, "unsubscribed", ev)
	return true, nil
}

// Unsubscribe handles the unsubscribe page and one-click unsubscribe. Unknown tokens are a no-op.
func (s *Service) Unsubscribe(ctx context.Context, token string) (bool, error) {
	m, err := s.messageByToken(ctx, token)
	if IsNotFound(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return s.UnsubscribeContact(ctx, m.ContactID, m)
}

// ValidUnsubscribeToken reports whether the unsubscribe page should offer the button.
func (s *Service) ValidUnsubscribeToken(ctx context.Context, token string) bool {
	_, err := s.messageByToken(ctx, token)
	return err == nil
}
