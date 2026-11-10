-- GPC Emailing: the schema that replaced the Firestore collections of the Firebase build.
-- Column names are the field names the dashboard reads, so rows go to the browser as they are.

-- Settings documents: app (plain JSON), status, senders, inbox. Secrets (API keys, webhook
-- secret) are sealed with SETTINGS_ENCRYPTION_KEY (AES-256-GCM).
CREATE TABLE settings (
    name       text PRIMARY KEY,
    data       jsonb NOT NULL DEFAULT '{}'::jsonb,
    sealed     bytea,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    category    text NOT NULL DEFAULT 'custom',
    mode        text NOT NULL DEFAULT 'dragdrop' CHECK (mode IN ('dragdrop', 'html')),
    subject     text NOT NULL DEFAULT '',
    design      jsonb,
    -- The dashboard renders drag-and-drop designs to html on save; sending uses this column.
    html        text NOT NULL DEFAULT '',
    is_standard boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lists (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- A contact's id is its lower-case e-mail address, or wa-<phone> for a WhatsApp-only contact.
CREATE TABLE contacts (
    id              text PRIMARY KEY,
    email           text NOT NULL DEFAULT '',
    first_name      text NOT NULL DEFAULT '',
    last_name       text NOT NULL DEFAULT '',
    company         text NOT NULL DEFAULT '',
    website         text NOT NULL DEFAULT '',
    phone           text NOT NULL DEFAULT '',
    phone_key       text NOT NULL DEFAULT '',
    country         text NOT NULL DEFAULT '',
    industry        text NOT NULL DEFAULT '',
    tags            text[] NOT NULL DEFAULT '{}',
    list_ids        text[] NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed', 'bounced')),
    source          text NOT NULL DEFAULT 'manual',
    created_at      timestamptz NOT NULL DEFAULT now(),
    replied_at      timestamptz,
    unsubscribed_at timestamptz,
    bounced_at      timestamptz
);
CREATE INDEX ix_contacts_list_ids ON contacts USING gin (list_ids);
CREATE INDEX ix_contacts_tags ON contacts USING gin (tags);
CREATE INDEX ix_contacts_status ON contacts (status);
CREATE INDEX ix_contacts_phone_key ON contacts (phone_key) WHERE phone_key <> '';
CREATE INDEX ix_contacts_created_at ON contacts (created_at DESC);

CREATE TABLE campaigns (
    id                 text PRIMARY KEY,
    name               text NOT NULL,
    subject            text NOT NULL DEFAULT '',
    preheader          text NOT NULL DEFAULT '',
    template_id        text,
    from_name          text NOT NULL DEFAULT '',
    from_email         text NOT NULL DEFAULT '',
    reply_to           text NOT NULL DEFAULT '',
    list_ids           text[] NOT NULL DEFAULT '{}',
    status             text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'launching', 'sending', 'paused', 'sent')),
    scheduled_at       timestamptz,
    started_at         timestamptz,
    finished_at        timestamptz,
    error              text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    stat_total         integer NOT NULL DEFAULT 0,
    stat_queued        integer NOT NULL DEFAULT 0,
    stat_sent          integer NOT NULL DEFAULT 0,
    stat_failed        integer NOT NULL DEFAULT 0,
    stat_skipped       integer NOT NULL DEFAULT 0,
    stat_opened        integer NOT NULL DEFAULT 0,
    stat_clicked       integer NOT NULL DEFAULT 0,
    stat_replied       integer NOT NULL DEFAULT 0,
    stat_unsubscribed  integer NOT NULL DEFAULT 0
);
CREATE INDEX ix_campaigns_status ON campaigns (status);

-- Tracked links: the key is an HMAC of the URL, so the click route never redirects anywhere
-- the worker did not put in an e-mail.
CREATE TABLE links (
    key        text PRIMARY KEY,
    url        text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_links (
    campaign_id text NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    link_key    text NOT NULL,
    url         text NOT NULL,
    clicks      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, link_key)
);

-- One row per e-mail to one person. The id is the 24-hex tracking token in its links.
CREATE TABLE messages (
    id                text PRIMARY KEY,
    campaign_id       text REFERENCES campaigns (id) ON DELETE CASCADE,
    campaign_name     text,
    automation_id     text,
    automation_run_id text,
    contact_id        text NOT NULL,
    email             text NOT NULL DEFAULT '',
    name              text NOT NULL DEFAULT '',
    company           text NOT NULL DEFAULT '',
    template_id       text,
    from_email        text,
    subject           text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    provider_id       text,  -- the SES message id
    rfc_message_id    text,  -- its Message-ID header: replies name it in In-Reply-To / References
    error             text,
    dry_run           boolean NOT NULL DEFAULT false,
    open_count        integer NOT NULL DEFAULT 0,
    click_count       integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    sent_at           timestamptz,
    opened_at         timestamptz,
    clicked_at        timestamptz,
    replied_at        timestamptz
);
CREATE INDEX ix_messages_queued ON messages (created_at) WHERE status = 'queued';
CREATE INDEX ix_messages_campaign ON messages (campaign_id);
CREATE INDEX ix_messages_contact ON messages (contact_id, created_at DESC);
CREATE INDEX ix_messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX ix_messages_rfc ON messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

CREATE TABLE automations (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    trigger_type   text NOT NULL,
    trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    steps          jsonb NOT NULL DEFAULT '[]'::jsonb,
    status         text NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused')),
    allow_reentry  boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One contact's way through an automation. `wait` steps park it until next_run_at.
CREATE TABLE runs (
    id              text PRIMARY KEY,
    automation_id   text NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
    automation_name text NOT NULL DEFAULT '',
    contact_id      text NOT NULL,
    email           text NOT NULL DEFAULT '',
    step_index      integer NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
    next_run_at     timestamptz NOT NULL DEFAULT now(),
    context         jsonb NOT NULL DEFAULT '{}'::jsonb,
    log             jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_runs_due ON runs (next_run_at) WHERE status = 'active';
CREATE INDEX ix_runs_automation_contact ON runs (automation_id, contact_id);
CREATE INDEX ix_runs_contact ON runs (contact_id) WHERE status = 'active';

-- E-mail and WhatsApp replies. E-mail ids are the SES receipt id (so a reply is stored once),
-- WhatsApp ids wa-<provider id>.
CREATE TABLE replies (
    id               text PRIMARY KEY,
    channel          text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp')),
    contact_id       text NOT NULL,
    message_id       text,
    campaign_id      text,
    campaign_name    text,
    original_subject text,
    from_email       text NOT NULL DEFAULT '',
    phone            text NOT NULL DEFAULT '',
    first_name       text NOT NULL DEFAULT '',
    last_name        text NOT NULL DEFAULT '',
    company          text NOT NULL DEFAULT '',
    subject          text NOT NULL DEFAULT '',
    body             text NOT NULL DEFAULT '',
    received_at      timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_replies_received ON replies (received_at DESC);
CREATE INDEX ix_replies_contact ON replies (contact_id, received_at DESC);

CREATE TABLE whatsapp (
    id            text PRIMARY KEY,
    contact_id    text NOT NULL,
    phone         text NOT NULL DEFAULT '',
    direction     text NOT NULL CHECK (direction IN ('in', 'out')),
    text          text NOT NULL DEFAULT '',
    automation_id text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_whatsapp_contact ON whatsapp (contact_id, created_at DESC);

CREATE TABLE autoreplies (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    enabled         boolean NOT NULL DEFAULT false,
    sort_order      integer NOT NULL DEFAULT 0,
    to_address      text NOT NULL DEFAULT '',
    audience        text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'new', 'contacts')),
    keywords        text NOT NULL DEFAULT '',
    exclude         text NOT NULL DEFAULT '',
    template_id     text NOT NULL,
    keep_thread     boolean NOT NULL DEFAULT true,
    from_mode       text NOT NULL DEFAULT 'recipient' CHECK (from_mode IN ('recipient', 'default', 'custom')),
    from_email      text NOT NULL DEFAULT '',
    cooldown_hours  integer NOT NULL DEFAULT 24,
    schedule        jsonb NOT NULL DEFAULT '{}'::jsonb,
    timezone        text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    create_contact  boolean NOT NULL DEFAULT false,
    list_id         text NOT NULL DEFAULT '',
    tags            text NOT NULL DEFAULT '',
    notify_email    text NOT NULL DEFAULT '',
    replied_count   integer NOT NULL DEFAULT 0,
    last_replied_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Every e-mail SES received on the reply domain (id s-<receipt id>), so each is handled once, and
-- what the auto-reply rules did with it.
CREATE TABLE inbound (
    id             text PRIMARY KEY,
    "from"         text NOT NULL DEFAULT '',
    from_email     text NOT NULL DEFAULT '',
    "to"           text[] NOT NULL DEFAULT '{}',
    subject        text NOT NULL DEFAULT '',
    snippet        text NOT NULL DEFAULT '',
    received_at    timestamptz NOT NULL,
    status         text NOT NULL DEFAULT 'received',
    reason         text,
    autoreply_rule text,
    replied_at     timestamptz,
    contact_id     text
);
CREATE INDEX ix_inbound_received ON inbound (received_at DESC);
CREATE INDEX ix_inbound_rule_sender ON inbound (autoreply_rule, from_email) WHERE replied_at IS NOT NULL;

-- Dashboard counters per UTC day.
CREATE TABLE daily_stats (
    day     date PRIMARY KEY,
    sent    integer NOT NULL DEFAULT 0,
    opens   integer NOT NULL DEFAULT 0,
    clicks  integer NOT NULL DEFAULT 0,
    replies integer NOT NULL DEFAULT 0
);

CREATE TABLE lead_searches (
    id            text PRIMARY KEY,
    params        jsonb NOT NULL,
    state         jsonb,
    status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    progress      text NOT NULL DEFAULT '',
    results_count integer NOT NULL DEFAULT 0,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);

CREATE TABLE leads (
    id         text NOT NULL,  -- the e-mail address
    search_id  text NOT NULL REFERENCES lead_searches (id) ON DELETE CASCADE,
    email      text NOT NULL,
    first_name text NOT NULL DEFAULT '',
    last_name  text NOT NULL DEFAULT '',
    position   text NOT NULL DEFAULT '',
    company    text NOT NULL DEFAULT '',
    website    text NOT NULL DEFAULT '',
    country    text NOT NULL DEFAULT '',
    industry   text NOT NULL DEFAULT '',
    source     text NOT NULL DEFAULT '',
    source_url text NOT NULL DEFAULT '',
    imported   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (search_id, id)
);

-- Images uploaded in the e-mail builder, served publicly at /img/<id> for use in e-mails.
CREATE TABLE uploads (
    id         text PRIMARY KEY,
    name       text NOT NULL DEFAULT '',
    mime_type  text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    data       bytea NOT NULL,
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
