package app

import (
	"context"
	"time"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

type Contact struct {
	ID        string     `db:"id" json:"id"`
	Email     string     `db:"email" json:"email"`
	FirstName string     `db:"first_name" json:"first_name"`
	LastName  string     `db:"last_name" json:"last_name"`
	Company   string     `db:"company" json:"company"`
	Website   string     `db:"website" json:"website"`
	Phone     string     `db:"phone" json:"phone"`
	PhoneKey  string     `db:"phone_key" json:"phone_key"`
	Country   string     `db:"country" json:"country"`
	Industry  string     `db:"industry" json:"industry"`
	Tags      []string   `db:"tags" json:"tags"`
	ListIDs   []string   `db:"list_ids" json:"list_ids"`
	Status    string     `db:"status" json:"status"`
	Source    string     `db:"source" json:"source"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	RepliedAt *time.Time `db:"replied_at" json:"replied_at"`
}

// Fields is the contact as merge-tag source (and the webhook step's payload).
func (c Contact) Fields() map[string]string {
	return map[string]string{
		"id": c.ID, "email": c.Email, "first_name": c.FirstName, "last_name": c.LastName, "company": c.Company,
		"website": c.Website, "phone": c.Phone, "country": c.Country, "industry": c.Industry, "status": c.Status,
	}
}

func (c Contact) Name() string { return core.FullName(c.FirstName, c.LastName) }

func (c Contact) HasTag(t string) bool { return contains(c.Tags, t) }

func (s *Service) contact(ctx context.Context, q store.Q, id string) (*Contact, error) {
	c, err := store.Struct[Contact](ctx, q, `SELECT * FROM contacts WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

type Message struct {
	ID           string     `db:"id"`
	CampaignID   *string    `db:"campaign_id"`
	CampaignName *string    `db:"campaign_name"`
	AutomationID *string    `db:"automation_id"`
	ContactID    string     `db:"contact_id"`
	Email        string     `db:"email"`
	TemplateID   *string    `db:"template_id"`
	FromEmail    *string    `db:"from_email"`
	Subject      string     `db:"subject"`
	Status       string     `db:"status"`
	GmailID      *string    `db:"gmail_id"`
	ThreadID     *string    `db:"thread_id"`
	Error        *string    `db:"error"`
	SentAt       *time.Time `db:"sent_at"`
	OpenedAt     *time.Time `db:"opened_at"`
	ClickedAt    *time.Time `db:"clicked_at"`
	RepliedAt    *time.Time `db:"replied_at"`
}

type Template struct {
	ID      string `db:"id"`
	Name    string `db:"name"`
	Mode    string `db:"mode"`
	Subject string `db:"subject"`
	HTML    string `db:"html"`
}

type Campaign struct {
	ID          string     `db:"id"`
	Name        string     `db:"name"`
	Subject     string     `db:"subject"`
	Preheader   string     `db:"preheader"`
	TemplateID  *string    `db:"template_id"`
	FromName    string     `db:"from_name"`
	FromEmail   string     `db:"from_email"`
	ReplyTo     string     `db:"reply_to"`
	ListIDs     []string   `db:"list_ids"`
	Status      string     `db:"status"`
	ScheduledAt *time.Time `db:"scheduled_at"`
	StartedAt   *time.Time `db:"started_at"`
}

type Automation struct {
	ID            string           `db:"id"`
	Name          string           `db:"name"`
	TriggerType   string           `db:"trigger_type"`
	TriggerConfig map[string]any   `db:"trigger_config"`
	Steps         []map[string]any `db:"steps"`
	Status        string           `db:"status"`
	AllowReentry  bool             `db:"allow_reentry"`
}

type Run struct {
	ID           string         `db:"id"`
	AutomationID string         `db:"automation_id"`
	ContactID    string         `db:"contact_id"`
	StepIndex    int            `db:"step_index"`
	Status       string         `db:"status"`
	Context      map[string]any `db:"context"`
	Log          []any          `db:"log"`
	CreatedAt    time.Time      `db:"created_at"`
}
