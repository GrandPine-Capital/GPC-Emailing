-- Opt-in and opt-out, subscribe forms, tag-based audiences.
-- Every statement can run again without harm (IF EXISTS / IF NOT EXISTS / ON CONFLICT).

-- pending: asked to confirm (double opt-in) and not mailed until they do.
-- complained: marked an e-mail as spam; never mailed again.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('subscribed', 'pending', 'unsubscribed', 'bounced', 'complained'));

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS confirmed_at       timestamptz,
    ADD COLUMN IF NOT EXISTS complained_at      timestamptz,
    -- A confirmation e-mail is owed while optin_sent_at is older than optin_requested_at.
    ADD COLUMN IF NOT EXISTS optin_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS optin_sent_at      timestamptz,
    -- What confirming applies: {"list_ids": [], "tags": [], "form_id": ""}.
    ADD COLUMN IF NOT EXISTS pending_optin      jsonb,
    ADD COLUMN IF NOT EXISTS unsubscribe_reason text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ix_contacts_optin_due ON contacts (optin_requested_at) WHERE status = 'pending';

-- Public lists are the ones a subscriber may join or leave on the preference page.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

-- A campaign goes to contacts on any of its lists and, when tags are set, carrying any of
-- those tags (tags alone when no list is chosen), minus the excluded lists and tags.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS tags             text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS exclude_list_ids text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS exclude_tags     text[] NOT NULL DEFAULT '{}';

-- Subscribe forms: a hosted page at /f/<id>, which also takes posts from a form embedded on
-- another website.
CREATE TABLE IF NOT EXISTS forms (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    title           text NOT NULL DEFAULT '',
    description     text NOT NULL DEFAULT '',
    button_text     text NOT NULL DEFAULT 'Subscribe',
    -- Fields asked besides the e-mail address: first_name, last_name, phone, company.
    fields          text[] NOT NULL DEFAULT '{first_name}',
    list_ids        text[] NOT NULL DEFAULT '{}',
    tags            text[] NOT NULL DEFAULT '{}',
    double_optin    boolean NOT NULL DEFAULT true,
    consent_text    text NOT NULL DEFAULT '',
    success_message text NOT NULL DEFAULT '',
    redirect_url    text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    submissions     integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The double opt-in e-mail. {{confirm_url}} is the confirmation link.
INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-confirm-subscription', 'Confirm Your Subscription', 'opt-in', 'html', 'Please confirm your subscription', NULL, '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title></title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px 32px 8px;font-family:Arial, Helvetica, sans-serif;"><h1 style="margin:0;font-size:24px;line-height:1.3;color:#111827;">Please confirm your subscription</h1></td></tr>
<tr><td style="padding:8px 32px;font-family:Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#374151;"><p style="margin:0 0 12px;">Hi {{first_name|there}},</p><p style="margin:0 0 12px;">Thank you for signing up to hear from {{sender_name}}. Please confirm that this is your e-mail address and that you would like to receive our e-mails.</p></td></tr>
<tr><td style="padding:12px 32px 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#2563eb;border-radius:6px;"><a href="{{confirm_url}}" target="_blank" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;font-family:Arial, Helvetica, sans-serif;">Yes, subscribe me</a></td></tr></table></td></tr>
<tr><td style="padding:0 32px 32px;font-family:Arial, Helvetica, sans-serif;font-size:13px;line-height:1.6;color:#6b7280;"><p style="margin:0 0 8px;">If you did not sign up, ignore this e-mail and you will not hear from us again.</p><p style="margin:0;">{{sender_name}} &middot; {{company_address}}</p></td></tr>
</table>
</td></tr>
</table>
</body>
</html>', true) ON CONFLICT (id) DO NOTHING;
