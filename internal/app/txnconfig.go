package app

import (
	"context"
	"strings"

	"github.com/grandpine-capital/gpc-emailing/internal/core"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
)

// The Transactional page's settings (settings document "transactional"): per event, whether it
// sends and which template it uses, and the sender. Nothing saved means the defaults: every
// event on, its keyed template, the sender from BILLING_FROM / BILLING_FROM_NAME.

// TxnEvent is a kind of transactional e-mail another system can ask for.
type TxnEvent struct {
	Event       string `json:"event"`
	Source      string `json:"source"`
	Label       string `json:"label"`
	Description string `json:"description"`
	DefaultKey  string `json:"default_key"` // templates.key used unless staff choose another
}

// TxnEvents is every transactional e-mail, in the order the page lists them.
var TxnEvents = []TxnEvent{
	{"payment.succeeded", "payment", "Payment receipt", "Sent when a payment succeeds: paid online, or marked paid by Finance.", "payment_receipt"},
	{"payment.pending", "payment", "Bank transfer instructions", "Sent when a buyer chooses bank transfer: the account, the reference and the pay-by date.", "payment_pending"},
	{"payment.refunded", "payment", "Refund notice", "Sent when Finance refunds an order.", "payment_refunded"},
	{"subscription.charge_upcoming", "payment", "Plan first-charge notice", "Sent 3 days before a plan's free days end: the date and amount of the first card charge.", "subscription_charge_upcoming"},
	{"helpdesk.password_reset", "helpdesk", "Helpdesk password reset", "Sent when a Helpdesk customer asks to reset their password.", "helpdesk_password_reset"},
	{"keycloak.execute_actions", "keycloak", "Account action e-mail (set a new password)", "Sent by Keycloak when a user asks ValueFarm for a new password, or staff send \"Credential reset\" from the admin console. Off: Keycloak sends its own e-mail.", "keycloak_execute_actions"},
	{"keycloak.password_reset", "keycloak", "Forgot password (login page)", "Sent by Keycloak when a user uses \"Forgot password?\" on the sign-in page. Off: Keycloak sends its own e-mail.", "keycloak_password_reset"},
	{"keycloak.verify_email", "keycloak", "Verify e-mail address", "Sent by Keycloak when a user has to confirm their e-mail address. Off: Keycloak sends its own e-mail.", "keycloak_verify_email"},
	{"crm.payment_failed", "crm", "CRM: payment failed", "Sent when the CRM reports that a customer's payment did not go through.", "crm_payment_failed"},
	{"crm.registration_confirmed", "crm", "CRM: registration confirmed", "Sent when the CRM confirms a customer's registration.", "crm_registration_confirmed"},
	{"crm.registration_failed", "crm", "CRM: registration failed", "Sent when the CRM could not complete a customer's registration.", "crm_registration_failed"},
	{"crm.owner_alert", "crm", "CRM: alert to staff", "Internal alert the CRM sends to staff; its subject and text are written by the CRM.", "crm_owner_alert"},
}

func txnEvent(event string) (TxnEvent, bool) {
	for _, e := range TxnEvents {
		if e.Event == event {
			return e, true
		}
	}
	return TxnEvent{}, false
}

type txnEventSetting struct {
	Off        bool   `json:"off"`
	TemplateID string `json:"template_id"`
	// WhatsApp is the same event's WhatsApp message (the events in whatsAppDefaultText); off unless set.
	WhatsApp txnWhatsApp `json:"whatsapp"`
}

type txnSettings struct {
	FromEmail string
	FromName  string
	Events    map[string]txnEventSetting
}

func (s *Service) txnSettings(ctx context.Context) txnSettings {
	d := s.doc(ctx, "transactional")
	out := txnSettings{FromEmail: str(d["from_email"]), FromName: str(d["from_name"]), Events: map[string]txnEventSetting{}}
	if ev, ok := d["events"].(map[string]any); ok {
		for k, v := range ev {
			m, _ := v.(map[string]any)
			out.Events[k] = txnEventSetting{Off: truthy(m["off"]), TemplateID: str(m["template_id"]), WhatsApp: whatsAppSetting(m["whatsapp"])}
		}
	}
	return out
}

// TransactionalConfig is the Transactional page: each e-mail with its setting and template, and
// the sender in use.
func (s *Service) TransactionalConfig(ctx context.Context) (map[string]any, error) {
	cfg := s.txnSettings(ctx)
	rows, err := store.Structs[Template](ctx, s.db.Pool, `SELECT id, name, mode, subject, html FROM templates`)
	if err != nil {
		return nil, err
	}
	byID := map[string]Template{}
	for _, t := range rows {
		byID[t.ID] = t
	}
	keyed := map[string]string{} // key -> id
	krows, err := s.db.Pool.Query(ctx, `SELECT key, id FROM templates WHERE key IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	for krows.Next() {
		var k, id string
		if err := krows.Scan(&k, &id); err != nil {
			krows.Close()
			return nil, err
		}
		keyed[k] = id
	}
	krows.Close()
	events := []map[string]any{}
	for _, e := range TxnEvents {
		set := cfg.Events[e.Event]
		chosen, custom := set.TemplateID, true
		if _, ok := byID[chosen]; !ok {
			chosen, custom = keyed[e.DefaultKey], false
		}
		ev := map[string]any{
			"event": e.Event, "source": e.Source, "label": e.Label, "description": e.Description,
			"enabled": !set.Off, "template_id": chosen, "template_name": byID[chosen].Name,
			"default_template_id": keyed[e.DefaultKey], "custom_template": custom,
		}
		if def, ok := whatsAppDefaultText[e.Event]; ok {
			w := set.WhatsApp.withDefaults()
			ev["whatsapp"] = map[string]any{"enabled": w.On, "channel": w.Channel, "kind": w.Kind, "text": w.Text,
				"template": w.Template, "language": w.Language, "params": w.Params, "default_text": def}
		}
		events = append(events, ev)
	}
	_, _, connected := s.waConnection(ctx)
	from, name := s.TransactionalFrom(ctx)
	return map[string]any{
		"events": events, "from_email": cfg.FromEmail, "from_name": cfg.FromName,
		"effective_from_email": from, "effective_from_name": name,
		"default_from_email": s.mailCfg.TransactionalFrom, "no_reply": IsNoReply(from),
		"payment_hook": s.PaymentEventSecret != "", "keycloak_hook": s.KeycloakEventSecret != "", "crm_hook": s.Secrets(ctx)["crm_hook_secret"] != "", "whatsapp_connected": connected,
	}, nil
}

// SaveTransactionalConfig saves the page (admin): {from_email, from_name, events: {<event>:
// {enabled, template_id, whatsapp}}}. An empty template_id is the default template; whatsapp
// (payment and Keycloak events) is {enabled, channel, kind, text, template, language, params}.
func (s *Service) SaveTransactionalConfig(ctx context.Context, b map[string]any) error {
	from := strings.ToLower(strings.TrimSpace(str(b["from_email"])))
	if from != "" {
		if !core.IsEmail(from) {
			return userErr("Enter a valid sender e-mail address, or leave it empty for the default")
		}
		if s.mail != nil && !s.senderAllowed(ctx, from) {
			return userErr(from + " is not on a verified SES identity (Settings → Sending → Sender identities)")
		}
	}
	events := map[string]any{}
	in, _ := b["events"].(map[string]any)
	for _, e := range TxnEvents {
		m, _ := in[e.Event].(map[string]any)
		set := map[string]any{"off": m != nil && m["enabled"] == false, "template_id": ""}
		if id := strings.TrimSpace(str(m["template_id"])); id != "" {
			var key *string
			err := s.db.Pool.QueryRow(ctx, `SELECT key FROM templates WHERE id = $1`, id).Scan(&key)
			if err != nil {
				return userErr("The template chosen for " + e.Label + " no longer exists")
			}
			if key == nil || *key != e.DefaultKey {
				set["template_id"] = id
			}
		}
		if _, ok := whatsAppDefaultText[e.Event]; ok && m != nil && m["whatsapp"] != nil {
			w, err := cleanWhatsApp(e, m["whatsapp"])
			if err != nil {
				return err
			}
			set["whatsapp"] = w
		}
		events[e.Event] = set
	}
	return s.mergeDoc(ctx, s.db.Pool, "transactional", map[string]any{
		"from_email": from, "from_name": strings.TrimSpace(str(b["from_name"])), "events": events,
	})
}
