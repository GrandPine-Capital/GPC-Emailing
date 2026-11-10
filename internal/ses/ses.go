// Package ses sends through Amazon SES and reads what SES delivers back: bounce and complaint
// events (configuration set → SNS → SQS) and inbound mail to the reply domain (receipt rule →
// S3, with an S3 event → SQS). Credentials come from the environment (the ECS task role).
package ses

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Config names the AWS resources. Region and the queues may sit in different regions: SES
// receives mail only in some regions (not ap-southeast-5), so inbound is usually elsewhere.
type Config struct {
	Region           string // sending region (SES_REGION)
	ConfigurationSet string // SES_CONFIGURATION_SET: bounce/complaint events
	EventsQueueURL   string // SQS queue fed by the configuration set's SNS topic
	InboundQueueURL  string // SQS queue fed by S3 events of the inbound bucket
}

// Client is the SES side of the service.
type Client struct {
	cfg     Config
	ses     *sesv2.Client
	sqsOut  *sqs.Client
	sqsIn   *sqs.Client
	s3In    *s3.Client
	mu      sync.Mutex
	quota   int
	quotaAt time.Time
	prod    bool
}

// regionOfQueue reads the region from an SQS queue URL (https://sqs.<region>.amazonaws.com/…).
func regionOfQueue(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	parts := strings.Split(p.Host, ".")
	if len(parts) >= 3 && parts[0] == "sqs" {
		return parts[1]
	}
	return ""
}

// New loads AWS credentials and builds the clients.
func New(ctx context.Context, cfg Config) (*Client, error) {
	base, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.Region))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	in := func(region string) aws.Config {
		c := base.Copy()
		if region != "" {
			c.Region = region
		}
		return c
	}
	c := &Client{cfg: cfg, ses: sesv2.NewFromConfig(base)}
	if cfg.EventsQueueURL != "" {
		c.sqsOut = sqs.NewFromConfig(in(regionOfQueue(cfg.EventsQueueURL)))
	}
	if cfg.InboundQueueURL != "" {
		r := regionOfQueue(cfg.InboundQueueURL)
		c.sqsIn = sqs.NewFromConfig(in(r))
		c.s3In = s3.NewFromConfig(in(r))
	}
	return c, nil
}

func (c *Client) Region() string { return c.cfg.Region }

// RFCMessageID is the Message-ID header SES gives a message it sent, so a follow-up can name it
// in In-Reply-To. us-east-1 uses email.amazonses.com, every other region its own name.
func RFCMessageID(region, sesID string) string {
	host := region + ".amazonses.com"
	if region == "us-east-1" {
		host = "email.amazonses.com"
	}
	return "<" + sesID + "@" + host + ">"
}

// Send sends a raw RFC 5322 message; the result is SES's message id.
func (c *Client) Send(ctx context.Context, raw []byte) (string, error) {
	in := &sesv2.SendEmailInput{Content: &sestypes.EmailContent{Raw: &sestypes.RawMessage{Data: raw}}}
	if c.cfg.ConfigurationSet != "" {
		in.ConfigurationSetName = aws.String(c.cfg.ConfigurationSet)
	}
	out, err := c.ses.SendEmail(ctx, in)
	if err != nil {
		return "", fmt.Errorf("SES: %w", err)
	}
	return aws.ToString(out.MessageId), nil
}

// Account is the sending account's state.
type Account struct {
	Production    bool    `json:"production"`
	Max24Hour     float64 `json:"max_24h"`
	SentLast24    float64 `json:"sent_last_24h"`
	MaxSendRate   float64 `json:"max_send_rate"`
	SendingActive bool    `json:"sending_enabled"`
}

func (c *Client) Account(ctx context.Context) (Account, error) {
	out, err := c.ses.GetAccount(ctx, &sesv2.GetAccountInput{})
	if err != nil {
		return Account{}, fmt.Errorf("SES: %w", err)
	}
	a := Account{Production: out.ProductionAccessEnabled, SendingActive: out.SendingEnabled}
	if q := out.SendQuota; q != nil {
		a.Max24Hour, a.SentLast24, a.MaxSendRate = q.Max24HourSend, q.SentLast24Hours, q.MaxSendRate
	}
	return a, nil
}

// Remaining is what SES still allows in the rolling 24 hours (cached for a minute).
func (c *Client) Remaining(ctx context.Context) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.quotaAt) < time.Minute {
		return c.quota, nil
	}
	a, err := c.Account(ctx)
	if err != nil {
		return 0, err
	}
	c.quota, c.quotaAt = max(0, int(a.Max24Hour-a.SentLast24)), time.Now()
	return c.quota, nil
}

// Identity is a verified SES sender: a whole domain or one address.
type Identity struct {
	Email    string `json:"email"` // the domain or the address
	Type     string `json:"type"`  // domain | email
	Verified bool   `json:"verified"`
	Name     string `json:"name"`
	Primary  bool   `json:"primary"`
}

func (c *Client) Identities(ctx context.Context) ([]Identity, error) {
	var out []Identity
	p := sesv2.NewListEmailIdentitiesPaginator(c.ses, &sesv2.ListEmailIdentitiesInput{})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("SES: %w", err)
		}
		for _, id := range page.EmailIdentities {
			t := "email"
			if id.IdentityType == sestypes.IdentityTypeDomain {
				t = "domain"
			}
			out = append(out, Identity{Email: strings.ToLower(aws.ToString(id.IdentityName)), Type: t,
				Verified: id.SendingEnabled && id.VerificationStatus == sestypes.VerificationStatusSuccess})
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- queues

// receive reads up to 10 queue messages; fn's error leaves a message for a later retry (SQS
// redelivers it after the visibility timeout, then its dead-letter queue takes it).
func receive(ctx context.Context, q *sqs.Client, queue string, fn func(body string) error) (int, error) {
	out, err := q.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{QueueUrl: aws.String(queue), MaxNumberOfMessages: 10, WaitTimeSeconds: 1})
	if err != nil {
		return 0, fmt.Errorf("SQS: %w", err)
	}
	n := 0
	var errs []error
	for _, m := range out.Messages {
		if err := fn(aws.ToString(m.Body)); err != nil {
			errs = append(errs, err)
			continue
		}
		if _, err := q.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(queue), ReceiptHandle: m.ReceiptHandle}); err != nil {
			errs = append(errs, err)
			continue
		}
		n++
	}
	return n, errors.Join(errs...)
}

// unwrapSNS returns the inner message of an SNS envelope (when the subscription is not raw).
func unwrapSNS(body string) string {
	var env struct {
		Type    string `json:"Type"`
		Message string `json:"Message"`
	}
	if json.Unmarshal([]byte(body), &env) == nil && env.Type == "Notification" && env.Message != "" {
		return env.Message
	}
	return body
}

// Event is an SES bounce or complaint.
type Event struct {
	Type       string   // Bounce | Complaint | (others are ignored)
	Permanent  bool     // a Permanent bounce
	MessageID  string   // SES message id of the e-mail it is about
	Recipients []string // lower-case addresses
}

// ParseEvent reads an SES event notification (configuration-set or identity format).
func ParseEvent(body string) (Event, error) {
	var n struct {
		EventType        string `json:"eventType"`
		NotificationType string `json:"notificationType"`
		Mail             struct {
			MessageID string `json:"messageId"`
		} `json:"mail"`
		Bounce struct {
			BounceType        string `json:"bounceType"`
			BouncedRecipients []struct {
				EmailAddress string `json:"emailAddress"`
			} `json:"bouncedRecipients"`
		} `json:"bounce"`
		Complaint struct {
			ComplainedRecipients []struct {
				EmailAddress string `json:"emailAddress"`
			} `json:"complainedRecipients"`
		} `json:"complaint"`
	}
	if err := json.Unmarshal([]byte(unwrapSNS(body)), &n); err != nil {
		return Event{}, err
	}
	ev := Event{Type: n.EventType, MessageID: n.Mail.MessageID}
	if ev.Type == "" {
		ev.Type = n.NotificationType
	}
	switch ev.Type {
	case "Bounce":
		ev.Permanent = n.Bounce.BounceType == "Permanent"
		for _, r := range n.Bounce.BouncedRecipients {
			ev.Recipients = append(ev.Recipients, strings.ToLower(r.EmailAddress))
		}
	case "Complaint":
		for _, r := range n.Complaint.ComplainedRecipients {
			ev.Recipients = append(ev.Recipients, strings.ToLower(r.EmailAddress))
		}
	}
	return ev, nil
}

// PollEvents hands each bounce/complaint to fn.
func (c *Client) PollEvents(ctx context.Context, fn func(Event) error) (int, error) {
	if c.sqsOut == nil {
		return 0, nil
	}
	return receive(ctx, c.sqsOut, c.cfg.EventsQueueURL, func(body string) error {
		ev, err := ParseEvent(body)
		if err != nil {
			return nil // not an event: drop it
		}
		return fn(ev)
	})
}

// s3Event is the S3 ObjectCreated notification.
type s3Event struct {
	Records []struct {
		S3 struct {
			Bucket struct {
				Name string `json:"name"`
			} `json:"bucket"`
			Object struct {
				Key string `json:"key"`
			} `json:"object"`
		} `json:"s3"`
	} `json:"Records"`
}

// PollInbound hands each received e-mail (raw MIME, with its S3 key as id) to fn.
func (c *Client) PollInbound(ctx context.Context, fn func(id string, raw []byte) error) (int, error) {
	if c.sqsIn == nil {
		return 0, nil
	}
	return receive(ctx, c.sqsIn, c.cfg.InboundQueueURL, func(body string) error {
		var ev s3Event
		if json.Unmarshal([]byte(unwrapSNS(body)), &ev) != nil {
			return nil
		}
		for _, r := range ev.Records {
			key, err := url.QueryUnescape(r.S3.Object.Key)
			if err != nil {
				key = r.S3.Object.Key
			}
			if key == "AMAZON_SES_SETUP_NOTIFICATION" || strings.HasSuffix(key, "/AMAZON_SES_SETUP_NOTIFICATION") {
				continue
			}
			obj, err := c.s3In.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(r.S3.Bucket.Name), Key: aws.String(key)})
			if err != nil {
				return fmt.Errorf("S3: %w", err)
			}
			raw, err := io.ReadAll(io.LimitReader(obj.Body, 40<<20))
			obj.Body.Close()
			if err != nil {
				return err
			}
			id := key[strings.LastIndex(key, "/")+1:]
			if err := fn(id, bytes.TrimLeft(raw, "\r\n")); err != nil {
				return err
			}
		}
		return nil
	})
}
