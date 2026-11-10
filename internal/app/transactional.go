package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/ids"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// Transactional e-mail is what other GrandPine systems ask this service to send to one person
// about one thing they did: a payment receipt, bank-transfer instructions, a refund notice.
// Unlike campaign mail it goes whatever the person's marketing status, makes no contact,
// carries no unsubscribe footer and is not tracked. Each request names a template by key and
// an idempotency key, so a system that asks twice (a retried webhook) sends once.

// TxnRequest asks for one transactional e-mail.
type TxnRequest struct {
	Source    string // the asking system, e.g. "payment"
	Key       string // idempotency key within Source, e.g. "payment.succeeded:<order id>"
	Template  string // templates.key, e.g. "payment_receipt"
	To        string
	ToName    string
	Reference string // the system's record the e-mail is about (the order id)
	Vars      map[string]string
}

// TxnRow is one transactional e-mail.
type TxnRow struct {
	ID          string            `db:"id" json:"id"`
	Source      string            `db:"source" json:"source"`
	SourceKey   string            `db:"source_key" json:"source_key"`
	TemplateKey string            `db:"template_key" json:"template_key"`
	ToEmail     string            `db:"to_email" json:"to_email"`
	ToName      string            `db:"to_name" json:"to_name"`
	Vars        map[string]string `db:"vars" json:"vars"`
	Reference   string            `db:"reference" json:"reference"`
	FromEmail   string            `db:"from_email" json:"from_email"`
	Subject     string            `db:"subject" json:"subject"`
	Status      string            `db:"status" json:"status"`
	Attempts    int               `db:"attempts" json:"attempts"`
	NextAttempt time.Time         `db:"next_attempt_at" json:"next_attempt_at"`
	Error       *string           `db:"error" json:"error"`
	ProviderID  *string           `db:"provider_id" json:"-"`
	RFCID       *string           `db:"rfc_message_id" json:"-"`
	DryRun      bool              `db:"dry_run" json:"dry_run"`
	CreatedAt   time.Time         `db:"created_at" json:"created_at"`
	SentAt      *time.Time        `db:"sent_at" json:"sent_at"`
}

const (
	// txnMaxAttempts: after this many failed sends the e-mail stays failed (staff can resend).
	txnMaxAttempts = 8
	// txnLease holds a row back from a second sender while one is sending it.
	txnLease = 2 * time.Minute
)

// QueueTransactional records the request, once per (Source, Key). It returns the row's id and
// whether this call created it.
func (s *Service) QueueTransactional(ctx context.Context, r TxnRequest) (string, bool, error) {
	r.To = strings.ToLower(strings.TrimSpace(r.To))
	switch {
	case r.Source == "" || r.Key == "" || r.Template == "":
		return "", false, userErr("source, key and template are required")
	case !core.IsEmail(r.To):
		return "", false, userErr("a valid recipient e-mail is required")
	}
	if r.Vars == nil {
		r.Vars = map[string]string{}
	}
	var id string
	err := s.db.Pool.QueryRow(ctx, `INSERT INTO transactional (id, source, source_key, template_key, to_email, to_name, vars, reference, created_at, next_attempt_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (source, source_key) DO NOTHING RETURNING id`,
		ids.New(), r.Source, r.Key, r.Template, r.To, strings.TrimSpace(r.ToName), r.Vars, r.Reference, s.now()).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.db.Pool.QueryRow(ctx, `SELECT id FROM transactional WHERE source = $1 AND source_key = $2`, r.Source, r.Key).Scan(&id)
		return id, false, err
	}
	return id, err == nil, err
}

// claimTransactional takes a queued, due row for sending: it counts the attempt and leases the
// row, so the worker and an inline send cannot both send it.
func (s *Service) claimTransactional(ctx context.Context, id string) (*TxnRow, error) {
	r, err := store.Struct[TxnRow](ctx, s.db.Pool, `UPDATE transactional SET attempts = attempts + 1, next_attempt_at = $2
		WHERE id = $1 AND status = 'queued' AND next_attempt_at <= $3 RETURNING *`, id, s.now().Add(txnLease), s.now())
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// txnBackoff is the wait after the n-th failed attempt: 1, 2, 4 … minutes, at most 6 hours.
func txnBackoff(n int) time.Duration {
	d := time.Minute
	for i := 1; i < n && d < 6*time.Hour; i++ {
		d *= 2
	}
	return min(d, 6*time.Hour)
}

// TransactionalFrom is the sender of transactional mail (BILLING_FROM, else the default sender).
func (s *Service) TransactionalFrom(ctx context.Context) (email, name string) {
	email, name = s.mailCfg.TransactionalFrom, s.mailCfg.TransactionalFromName
	if email == "" {
		email = s.Account(ctx)
	}
	if name == "" {
		name = s.Settings(ctx).FromName
	}
	return email, name
}

// SendTransactional sends the queued row id now if it is due. It returns the row's status; a
// failed attempt stays queued for the worker until txnMaxAttempts.
func (s *Service) SendTransactional(ctx context.Context, id string) (string, error) {
	r, err := s.claimTransactional(ctx, id)
	if IsNotFound(err) {
		var st string
		_ = s.db.Pool.QueryRow(ctx, `SELECT status FROM transactional WHERE id = $1`, id).Scan(&st)
		return st, nil // already sent, or not due yet
	} else if err != nil {
		return "", err
	}
	fail := func(cause error, final bool) (string, error) {
		status, next := "queued", s.now().Add(txnBackoff(r.Attempts))
		if final || r.Attempts >= txnMaxAttempts {
			status = "failed"
		}
		_, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET status = $2, next_attempt_at = $3, error = $4 WHERE id = $1`,
			r.ID, status, next, core.Truncate(cause.Error(), 500))
		return status, errors.Join(cause, err)
	}
	if err := s.canSend(ctx); err != nil {
		// Not a failure of this e-mail: wait for sending to be set up, without using up attempts.
		_, uerr := s.db.Pool.Exec(ctx, `UPDATE transactional SET attempts = attempts - 1, next_attempt_at = $2, error = $3 WHERE id = $1`,
			r.ID, s.now().Add(time.Hour), err.Error())
		return "queued", errors.Join(err, uerr)
	}
	var t Template
	t, err = store.Struct[Template](ctx, s.db.Pool, `SELECT id, name, mode, subject, html FROM templates WHERE key = $1`, r.TemplateKey)
	if IsNotFound(err) {
		return fail(fmt.Errorf("no template with key %q", r.TemplateKey), true)
	} else if err != nil {
		return fail(err, false)
	}
	vars := map[string]string{}
	for k, v := range r.Vars {
		vars[k] = v
	}
	if vars["first_name"] == "" {
		vars["first_name"] = strings.Fields(r.ToName + " ")[0]
	}
	if vars["full_name"] == "" {
		vars["full_name"] = r.ToName
	}
	vars["email"] = r.ToEmail
	st := s.Settings(ctx)
	vars["company_address"], vars["sender_name"] = st.CompanyAddress, st.FromName
	subject := t.Subject
	if subject == "" {
		subject = t.Name
	}
	text := core.HTMLToText(core.Merge(t.HTML, vars, false))
	html := core.Merge(t.HTML, vars, true)
	subject = core.Merge(subject, vars, false)

	from, fromName := s.TransactionalFrom(ctx)
	replyTo := s.replyAddress(from)
	if replyTo == "" {
		replyTo = from
	}
	res, err := s.Send(ctx, Outgoing{To: r.ToEmail, ToName: r.ToName, Subject: subject, HTML: html, Text: text,
		FromEmail: from, FromName: fromName, ReplyTo: replyTo,
		Headers: map[string]string{"X-GPC-Transactional": r.TemplateKey}})
	if err != nil {
		return fail(err, false)
	}
	_, err = s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'sent', provider_id = $2, rfc_message_id = $3, subject = $4,
		from_email = $5, sent_at = $6, error = NULL, dry_run = $7 WHERE id = $1`,
		r.ID, res.ID, nilIfEmpty(res.RFCMessageID), subject, from, s.now(), res.DryRun)
	return "sent", err
}

// processTransactional sends the due queued transactional mail (the worker's retries).
func (s *Service) processTransactional(ctx context.Context, hasTime func() bool) (int, error) {
	if err := s.canSend(ctx); err != nil {
		return 0, err
	}
	rows, err := s.db.Pool.Query(ctx, `SELECT id FROM transactional WHERE status = 'queued' AND next_attempt_at <= $1
		ORDER BY next_attempt_at LIMIT 200`, s.now())
	if err != nil {
		return 0, err
	}
	due, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range due {
		if !hasTime() {
			break
		}
		if st, err := s.SendTransactional(ctx, id); err != nil {
			s.log.Warn("transactional send", "id", id, "status", st, "err", err)
		} else if st == "sent" {
			n++
		}
	}
	return n, nil
}

// noteTransactionalEvent records an SES bounce or complaint against the transactional e-mail
// it is about, if it is one.
func (s *Service) noteTransactionalEvent(ctx context.Context, providerID, status string) {
	if providerID == "" {
		return
	}
	if _, err := s.db.Pool.Exec(ctx, `UPDATE transactional SET status = $2 WHERE provider_id = $1`, providerID, status); err != nil {
		s.log.Warn("transactional event", "err", err)
	}
}

// Transactionals lists transactional mail, newest first, for the dashboard and for the
// systems that asked (filter by source and reference).
func (s *Service) Transactionals(ctx context.Context, source, reference, status string, limit int) ([]TxnRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	return store.Structs[TxnRow](ctx, s.db.Pool, `SELECT * FROM transactional
		WHERE ($1 = '' OR source = $1) AND ($2 = '' OR reference = $2) AND ($3 = '' OR status = $3)
		ORDER BY created_at DESC LIMIT $4`, source, reference, status, limit)
}

// ResendTransactional queues a transactional e-mail again (a failed one, or a copy the person
// asked for) and sends it now.
func (s *Service) ResendTransactional(ctx context.Context, id string) (string, error) {
	if err := store.Affected(s.db.Pool.Exec(ctx, `UPDATE transactional SET status = 'queued', attempts = 0, next_attempt_at = $2, error = NULL
		WHERE id = $1`, id, s.now())); err != nil {
		return "", err
	}
	return s.SendTransactional(ctx, id)
}
