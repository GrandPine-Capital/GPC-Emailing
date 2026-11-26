# GPC Emailing

E-mail marketing for **GrandPine Capital**: contacts, lists and tags, subscribe forms with
double opt-in, a drag-and-drop and HTML template builder, campaigns (by list and tag) with
open/click/reply tracking, automations (email, tagging, WhatsApp, ChatDaddy, webhooks),
auto-replies to incoming mail, inbound webhooks and a lead finder.

A Go service (`cmd/emailing`) serves the dashboard (`web/`, plain HTML and JavaScript), its
API under `/api`, the public routes that e-mails and other apps reach, and runs the
background worker, over one Postgres database whose schema Flyway owns (`db/migration`).
Mail goes out through **Amazon SES**; replies come back through an SES-received **reply
domain**, are recorded, and are forwarded to the sender's own mailbox.

| Concern | How |
|---|---|
| Staff sign-in | GrandPine staff realm (Keycloak, `gpc-staff`), client `emailing-staging`; the client role is the access level |
| Database | PostgreSQL 17; Flyway migrations in `db/migration` |
| Sending | Amazon SES (API, the task role), from any address at a verified SES identity |
| Bounces, complaints | SES configuration set → SNS → SQS, read by the worker |
| Replies | Reply-To `name@<REPLY_DOMAIN>` → SES inbound → S3 → SQS; recorded, then forwarded to `name@<sending domain>` |
| Background work | The worker in the same process: every `WORKER_INTERVAL` (5 min), and straight after a send, activation or enrolment |
| WhatsApp | ChatDaddy or the WhatsApp Cloud API, called from the server |
| Images in e-mails | Stored in Postgres, served at `/img/<id>` |
| Deploy | One distroless image (dashboard embedded) + a Flyway image, ECS Fargate |

> This replaced the Firebase build (Firebase Hosting + Firestore + a Google Apps Script
> worker). The features and the dashboard are the same; see **Moving from the Firebase
> build** below for what changed.

## Who is who

Staff sign in with their GrandPine account; access is granted in the IAM Workspace on the
`emailing-staging` client:

| Realm role | In Emailing |
|---|---|
| `admin` | Everything, plus Settings and integration keys |
| `editor` | Campaigns, contacts, templates, automations, auto-replies, lead finder |
| `viewer` | Read-only: every write answers 403 |

## What runs where

```
 Browser (dashboard) ── SSO (gpc-staff) ──┐
        │ /api/*  (Bearer token)           │
        ▼                                  ▼
 ┌──────────────────────────────┐   Keycloak realm
 │ emailing (Go)                │
 │  • API + dashboard           │◄── recipients: /o (open pixel), /r (click),
 │  • worker: queue, inbox,     │                /u, /u1 (unsubscribe)
 │    automations, lead finder  │◄── /hook (ChatDaddy, forms, Zapier)
 └──────┬───────────────┬───────┘
        │               │ SES send ─► recipients
        ▼               │ SQS ◄─ SES events (bounces, complaints)
   PostgreSQL           │ SQS ◄─ S3 ◄─ SES inbound (replies to name@REPLY_DOMAIN)
                        └ forwards replies ─► name@<sending domain> (staff mailbox)
```

The worker steps, in order, each tick (`internal/app/worker.go`): send the opt-in confirmation
e-mails that are owed; launch due campaigns and
send queued mail within the daily limit and the SES quota; apply SES bounces (permanent →
contact bounced) and complaints (→ unsubscribed); read mail received on the reply domain
(replies, delivery reports, "unsubscribe" requests, auto-reply rules, the `email_received`
trigger) and forward each to the mailbox it was meant for; advance due automation runs;
advance the oldest lead search. A Postgres advisory lock keeps one tick at a time even while a
deploy runs two tasks.

Replies are matched to the e-mail they answer by the Message-ID they name (In-Reply-To /
References), else to the contact's latest e-mail. A campaign with its own **Reply-to** sends
replies there instead, and they are not tracked. Forwarded copies carry
`X-GPC-Emailing-Forwarded`, so a mailbox rule that sends them back cannot loop.

Mail never fails for lack of SES: without it, queued mail waits and automation sends retry
hourly. **Dry-run mode** (Settings → Sending) records and tracks sends without delivering.

## Opt-in, opt-out and tags

| | |
|---|---|
| Subscribe forms | **Subscribe forms**: each has a hosted page at `/f/<id>`; the same address takes the post of a form embedded on another site (HTML snippet in the dashboard), or JSON from a script. A hidden field and a per-address rate limit keep bots out |
| Double opt-in | The sign-up is `pending`, and unmailed, until the person uses the link in the confirmation e-mail (`/c`; the page asks, a button confirms, so mail scanners confirm nothing). The form's lists and tags apply at that moment. The e-mail is a template (`{{confirm_url}}`), chosen in Settings → Sending. Webhooks can ask for it with `"double_optin": true` |
| Contact status | `subscribed`, `pending`, `unsubscribed`, `bounced`, `complained` (a spam complaint; never mailed or re-subscribed). Only `subscribed` contacts are mailed |
| Unsubscribe | `/u` (asks why, optionally; the reason is kept on the contact), one-click `/u1`, or a reply saying "unsubscribe" |
| Preference page | `/m`: the subscriber's name and the **public** lists they may join or leave. `{{manage_subscription_url}}`; a link is added to the footer |
| View in browser | `/v`, `{{view_online_url}}`: the e-mail re-rendered for its recipient, served sandboxed |
| Tags | **Tags** lists, renames (merges) and removes tags. Campaigns go to lists and/or tags, minus excluded lists and tags |
| Automations | Triggers include tag added / removed, added to / removed from a list, form submitted, subscription confirmed. Steps include add / remove tag, **Only continue if…** (skip the next steps or end), **Wait until…** (a goal with a time limit), start / stop another automation |

## Transactional mail (receipts)

Other systems ask Emailing to send one e-mail to one person about one thing: a receipt, a
bank-transfer reminder, a refund notice. That mail is **not marketing**: it goes even to
people who unsubscribed, makes no contact, carries no unsubscribe footer and is not tracked.
It is sent from `BILLING_FROM`, with replies through the reply domain to the same name; a
no-reply sender (`no-reply@…`, `noreply@…`) gets no Reply-To at all.

| Payment event | Template key | Sent |
|---|---|---|
| `payment.succeeded` | `payment_receipt` | Receipt, with the link to the receipt page (event check-in QR) |
| `payment.pending` | `payment_pending` | Bank-transfer instructions: account, reference, pay-by date |
| `payment.refunded` | `payment_refunded` | Refund notice |
| `subscription.charge_upcoming` | `subscription_charge_upcoming` | Plan first-charge notice, 3 days before a free trial ends: the date and amount of the first card charge, then yearly |

GPC-Payment delivers its events to `POST /hooks/payments` (outbox target `emailing`, its
`EMAILING_BASE_URL` and `EMAILING_EVENT_SECRET`), signed like its CRM events: header
`sig` = hex HMAC-SHA256 of the body with `PAYMENT_EVENT_SECRET` (the same value). Each send
is kept in `transactional`, once per event and order, so a retried event sends nothing new;
a failed send is retried by the worker (1, 2, 4 … minutes, 8 tries), and SES bounces and
complaints mark the row. Staff see them at `GET /api/transactional?source=payment&reference=<order id>`
and resend with `POST /api/transactional/{id}/resend`.

**WhatsApp.** Each payment e-mail can also go to the buyer's WhatsApp (Settings → Transactional e-mails → *Also send
on WhatsApp*; off for every event until ticked), through GPC-WhatsApp's API (`POST /api/v1/messages`), so
the message sits in that platform's inbox and its opt-outs and daily limits apply. Settings →
Integrations → *GPC WhatsApp* holds the platform's address and an API key of the company there (scopes
`read` and `messages:write`). Each event picks its number: the company's personal number with free text
(merge tags as in the e-mail; a line whose tags all come out empty is left out), or a WABA number with an
approved template whose body parameters are merge tags. The message is a `transactional` row with
`channel = 'whatsapp'` and `to_phone` in international digits (a local `0…` number takes the default
country code, else 60), made once per event and order. Its sends carry the idempotency key
`emailing:<row id>#<resends>`, so the worker's retries reach the customer once and a staff resend is a new
message; a 400, 401, 403 or 404 fails at once, anything else is retried like e-mail, and none of it waits
for SES. The CRM (GPC-Lead) can send its own WhatsApp on payment events: switch that off before ticking
these, or buyers get two.

### GPC-WhatsApp's webhook: replies and delivery status

`POST /hooks/whatsapp` receives GPC-WhatsApp's outbound webhooks (header `X-GPC-Signature: sha256=<hex
HMAC-SHA256 of the raw body>`, header `X-GPC-Event`), signed with the secret `gpc_whatsapp_webhook_secret`.

**Automatic set-up.** Once the platform address and API key are saved (Settings → Integrations → GPC
WhatsApp) and no secret is stored, this service creates its own webhook there (`GET /api/v1/me`, then
`POST /api/v1/webhooks` for `<PUBLIC_BASE_URL>/hooks/whatsapp` with the events `message.received` and
`message.status`) and stores the returned signing secret itself. The API key needs the scope
`webhooks:write` (or `*`); without it the card says so and nothing is created. An older webhook with exactly
this URL is deleted first (its secret cannot be read back); webhooks with other URLs are never touched. It
runs when the connection is saved, from the "Connect replies now" button, and from the worker at most every
30 minutes while it is not connected. The progress (`connected`, `needs_scope`, `failed`, `no_url`) is the
settings document `wa_webhook`, shown on the card; it never holds the key or the secret, and GET /settings
never returns the webhook secret. **Manual fallback:** create the webhook in GPC-WhatsApp yourself and paste
its secret under "Enter a secret by hand" (write-only; empty keeps the current one). A stored secret, typed or
automatic, stops the automatic set-up. Secret unset: 503; bad, missing or unprefixed signature: 401; body over 256 KB or not
JSON: 400. Anything validly signed gets a 200, including events not used here, because the platform does
not retry and switches a webhook off after 20 failures in a row.

- `message.received` is handled like the ChatDaddy webhook: the sender's number is matched on `phone_key`
  (an unknown number becomes a contact with source `whatsapp`), one `replies` row per platform message id
  (a repeated delivery is recorded once), the `whatsapp_received` trigger fires and `stop_if: replied`
  steps stop.
- `message.status` finds the send by the platform's message id: `transactional.provider_id` (payment and
  Keycloak notices) or `whatsapp.id = 'wa-<id>'` (automations). `failed` marks the transactional row
  `failed` with the error shown in Settings → Transactional e-mails; it is not resent by itself (use Resend).
  `delivered`, `read` and an automation send's failure are acknowledged and not stored (there is no column
  for them). An unknown id answers `{"ok":true,"ignored":"unknown message"}`.

### The ChatDaddy switch

ChatDaddy is the old WhatsApp provider; Settings → Integrations → *Use ChatDaddy* (`chatdaddy_enabled`) turns
it on or off in one place. Off: nothing is sent to or accepted from ChatDaddy. A send that asks for ChatDaddy
goes through GPC-WhatsApp instead (the run log says so), the *Sync contact to ChatDaddy* step is skipped, a
`/hook?src=chatdaddy` call answers 200 `{"ok":true,"ignored":"ChatDaddy is switched off"}` and records nothing,
and the test send follows the same rule. Never saved, the switch is on only if a ChatDaddy token is stored and
the saved provider is `chatdaddy` (so a live installation keeps working on deploy), otherwise off; once saved,
the saved value wins. The settings form posts the effective value, so saving other settings does not flip it.

### The CRM's contact sync and e-mails

The CRM (GPC-Lead, crm.grandpine.com) is the master of customer records and posts to three routes,
all signed with header `sig` = lowercase hex HMAC-SHA256 of the raw body with the admin setting
`crm_hook_secret`. Secret unset: 503; bad or missing signature: 401; malformed body: 400.
Unsubscribe state and the send log stay only here.

To connect the two, an administrator opens **Settings → Integrations → CRM (GPC-Lead)** here. The
card shows the address to enter in the CRM (this service's public base URL, with a copy button) and
the **Signing secret**: press Generate (or type your own), copy it, paste it into the CRM under
Admin → Settings → Customer sync and e-mail channel → Signing secret, and save here. The same
secret must be in both. After saving it is hidden, and the card says Connected. The card also shows
the time and kind of the last signed call the CRM made. There is no env var.

**`POST /hooks/crm/ping`** (body up to 4 KB, any small JSON such as `{"ping":true}`) is a
connection test: with a good signature it answers `200 {"ok":true,"service":"gpc-emailing"}` and
changes nothing else. Every signed call (ping, contacts, events) is noted as the "last call".

**`POST /hooks/crm/contacts`** (body up to 2 MB, at most 500 contacts) is a quiet one-way sync:

```json
{"tagPrefix": "crm:", "contacts": [
  {"email": "a@b.my", "externalId": "82092", "name": "Tan Ah Kow", "phone": "+60123456789",
   "tags": ["crm:vip", "crm:cat:customer"], "subscribed": true},
  {"email": "old@b.my", "externalId": "77", "remove": true}]}
```

- `tagPrefix` is required (1 to 20 characters) and every tag must start with it, else that contact is invalid.
- Not present: created with source `crm`, name split into first and last name, phone, tags, and status
  `subscribed` (`unsubscribed` if `"subscribed": false`).
- Present: name and phone are overwritten when given and non-empty; the tags with the prefix are replaced by
  the request's; other tags and the lists are never touched; the status is never changed (an
  unsubscribed, bounced or complained contact stays so).
- `remove: true` never deletes: it strips the prefixed tags only. An unknown address is left alone.
- A contact already equal to the request counts as `unchanged` and is not written.
- It starts no automation (no contact-added or tag-added), sends nothing and calls no WhatsApp service.
- One bad contact never fails the batch. Answer: `{"ok": true, "created": n, "updated": n, "unchanged": n,
  "invalid": [{"index": i, "reason": "…"}]}`; reasons never repeat an address, name or number.
  An address twice in one call is invalid the second time.

**`POST /hooks/crm/events`** (body up to 64 KB) asks for a transactional e-mail, like `/hooks/payments`:

```json
{"type": "crm.payment_failed", "key": "payment_failed__pay_123", "to": {"name": "Tan", "email": "a@b.my"},
 "vars": {"product": "VF Pro", "amount": "199.00", "currency": "MYR", "reference": "INV-1"}}
```

| Type | Template key |
|---|---|
| `crm.payment_failed` | `crm_payment_failed` |
| `crm.registration_confirmed` | `crm_registration_confirmed` |
| `crm.registration_failed` | `crm_registration_failed` |
| `crm.owner_alert` (staff only; `vars.subject` and `vars.body` are the whole message, shown as escaped plain text) | `crm_owner_alert` |

Each has its own on/off switch, template and sender in Settings → Transactional e-mails (all on by default) and is
sent whatever the person's marketing status, without tracking or an unsubscribe footer. `key` makes it
once-only (source `crm`): the same key again answers `created: false`. Answer `{"ok": true, "id", "created",
"status"}`, or `{"ok": true, "ignored": "…"}` for an unknown type, a switched-off event or no e-mail address.
Only `product`, `amount`, `currency`, `reference`, `subject` and `body` are read from `vars`.

### Keycloak's account e-mails

The Keycloak image (ValueFarm.KeycloakTheme, `providers/gpc-email-hook`) hands its account e-mails to
`POST /hooks/keycloak` instead of sending them itself, signed like the hooks above with
`KEYCLOAK_EVENT_SECRET` (unset: the hook answers 503).

| Keycloak sends | Event | Template key |
|---|---|---|
| "Credential reset" / execute-actions e-mail (ValueFarm's forgot-password) | `keycloak.execute_actions` | `keycloak_execute_actions` |
| "Forgot password?" on the sign-in page | `keycloak.password_reset` | `keycloak_password_reset` |
| Verify e-mail address | `keycloak.verify_email` | `keycloak_verify_email` |

```json
{"type": "keycloak.password_reset", "id": "<one per e-mail>", "occurred_at": "2026-11-23T06:00:00Z",
 "realm": "valuefarm", "realm_name": "ValueFarm",
 "user": {"id": "…", "username": "…", "email": "…", "first_name": "…", "last_name": "…", "phone": "…"},
 "link": "https://…/login-actions/action-token?key=…", "expires_in": "12 hours",
 "expires_at": "2026-11-23T18:00:00Z", "required_actions": "Update Password"}
```

The answer carries `"handled"`. It is `true` only when the e-mail **has been sent**; on anything else
(the event switched off in Settings → Transactional e-mails, dry-run mode, SES refusing, a missing template, any
error status or a timeout) Keycloak sends its own e-mail from its theme, so someone asking for a new
password always gets one. A row that was left to Keycloak is closed as `skipped`: the worker does not send
it later. Merge tags: `action_url` (Keycloak's link, single use), `expires_in`, `expires_at`,
`first_name`, `full_name`, `username`, `realm_name`, `required_actions`, `company_address`.

Each can also send a **WhatsApp notice** ("we have e-mailed you a link…") to the phone number on the
Keycloak account, set up like the payment ones (off until ticked). The link is never among a notice's
merge values, so it cannot be put into a WhatsApp message: a phone number on an account is not verified.
The notice is queued with the answer and sent by the worker straight after, so Keycloak is not kept
waiting.

**Settings → Transactional e-mails** (a tab of Settings; the old Transactional page and
`#/transactional` redirect to it) lists every one of these e-mails in a table ("System & lifecycle
emails") and sets whether it is on, which template it uses and its WhatsApp copy; the same table
shows the Keycloak templates nothing sends yet and the standard lifecycle flows (sign-up,
onboarding, install, trial, billing, opt-out) still to be created as automations. The tab also
sets the sender (empty = `BILLING_FROM` / `BILLING_FROM_NAME`); it
lists everything sent, searchable by order number or address, with Resend. Admins change the
settings; editors may resend. The templates are ordinary HTML templates (category
*transactional*): edit the wording there. A template with a key cannot be deleted. Merge tags: `first_name`,
`full_name`, `item`, `amount` (`RM 1,234.50`), `paid_at`, `payment_method`, `order_id`,
`receipt_url`, `instructions_url`, `payment_reference`, `expires_at`, `bank_name`,
`account_name`, `account_number`, `duitnow_id`, `refunded_at`, `charge_at` (`25 Nov 2026`),
`charge_amount`, `company_address`.

## Run it locally

```bash
cp .env.example .env                      # set SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up --build                 # Postgres, Flyway, the service on :8080
```

or against your own Postgres: `make migrate` (or Flyway by hand), then `make run`. With
`AUTH_MODE=dev` the sign-in page takes a token such as `dev:alex:admin` (admin, editor or
viewer).

To send for real locally, set `SES_REGION` and `MAIL_FROM` (a verified identity) with AWS
credentials in the environment (`AWS_PROFILE`).

Tests: `make test`. The Postgres tests need `TEST_DATABASE_URL` pointing at a server where the
user may `CREATE DATABASE` (each test gets a fresh database with the migrations applied).

## Deploy

`.github/workflows/deploy.yml`: branch `staging` deploys to the GitHub environment `staging`
(https://emailing-staging.grandpine.com), `main` to `prod`. It builds the app image and the
Flyway image, runs the migrations as a one-off Fargate task, then rolls the ECS service.

### One-time setup

Infrastructure is in ValueFarm.Infra (`staging/emailing.tf`, `staging/services/emailing`, its
README has the steps): the ECS service, the database, the SES configuration set and event
queue in the sending region, and the reply bucket, receipt rule and inbound queue in the
receiving region (SES does not receive mail in ap-southeast-5). Then:

1. **Staff realm client** `emailing-staging` in `gpc-staff` (`iam/`).
2. **DNS**: `MX reply.grandpine.com → 10 inbound-smtp.ap-southeast-1.amazonaws.com`; the
   sending domain's DKIM records are already in place for `grandpine.com`.
3. **Service environment** (the task definition sets it): `DATABASE_URL`,
   `SETTINGS_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `KEYCLOAK_*`, `SES_REGION`, `MAIL_FROM`,
   `SES_CONFIGURATION_SET`, `SES_EVENTS_QUEUE_URL`, `REPLY_DOMAIN`, `SES_INBOUND_QUEUE_URL`;
   for receipts, `PAYMENT_EVENT_SECRET`, `BILLING_FROM` (e.g. `billing@grandpine.com`) and
   optionally `BILLING_FROM_NAME`; for Keycloak's account e-mails, `KEYCLOAK_EVENT_SECRET` (the
   same value as `GPC_EMAIL_HOOK_SECRET` on the Keycloak task).

A release keeps serving while the next one's migration runs: a read that meets a table the
migration has just changed is retried once (`internal/store`), so adding columns is safe;
dropping or renaming a column the running release reads is not, and needs two releases.

`SETTINGS_ENCRYPTION_KEY` and `PUBLIC_BASE_URL` must stay the same once mail has gone out:
the key signs click-tracking links; the URL is in every tracking and unsubscribe link.

## Limits

| | |
|---|---|
| SES | 50,000/day at 14/s in ap-southeast-5 (out of the sandbox); **Max emails per day** caps it further |
| Per worker run | **Max emails per worker run** (default 40) every `WORKER_INTERVAL` |
| Lead finder | DuckDuckGo with no key; Google Programmable Search 100 queries/day free; Hunter.io / Apollo.io with their keys |

Campaigns over the daily cap carry on the next day by themselves.

## Code map

| Path | What |
|---|---|
| `cmd/emailing` | Wiring: config, database, auth, worker, HTTP server |
| `internal/app` | The service: delivery and tracking, campaigns, replies and bounces, automations, auto-replies, webhooks, lead searches, the dashboard's operations, the worker |
| `internal/ses` | SES sending, quota and identities; the events and inbound queues; parsing received mail |
| `internal/leads` | Lead finder: search engines, Hunter, Apollo, the robots.txt-aware crawler |
| `internal/core` | Merge tags, HTML-to-text, address and phone helpers (the same as `web/shared/email-core.js`) |
| `internal/catalog` | Countries, focus industries, trigger and step names; `catalog.json` is generated from `web/shared/catalog.js` by `node scripts/gen-catalog.js` |
| `internal/httpapi` | API routes, public routes, staff sign-in |
| `web/` | The dashboard. `js/backend.js` is the API client; templates are rendered to HTML in the browser (`shared/render-blocks.js`) and the server sends the saved HTML |
| `db/migration` | `V1` schema, `V2` standard templates and (paused) example automations, `V3`–`V7` transactional mail, `V8` opt-in, forms and tag audiences, `V9` WhatsApp notices, `V10` Keycloak's account e-mails, `V11` the rest of Keycloak's e-mails as templates (not sent from here yet), `V12` the CRM's e-mails |

## Moving from the Firebase build

| Firebase build | Now |
|---|---|
| Firebase Auth (Google / e-mail link) + Firestore `admins/` | GrandPine SSO; roles from IAM (owner/admin → `admin`, member → `editor`) |
| Firestore | Postgres (`db/migration/V1__emailing.sql`) |
| Apps Script worker as the owner's Gmail (5-minute trigger) | The Go worker; mail through Amazon SES |
| Replies read from the Gmail inbox | Replies to the SES reply domain, forwarded to the sender's mailbox |
| "Send mail as" aliases | Any address at a verified SES domain |
| Clicks and unsubscribes queued in Firestore by `r.html` / `u.html` | Recorded at once by `/r` and `/u` (the old paths `/r.html`, `/u.html` still work on this host) |
| Open pixel and one-click unsubscribe on the Apps Script URL | `/o`, `/u1` on `PUBLIC_BASE_URL` |
| Webhooks at `<Apps Script URL>?a=hook&k=…` | `PUBLIC_BASE_URL/hook?k=…`: update ChatDaddy and form/Zapier URLs (Settings shows them) |
| Images in Google Drive | Postgres, `/img/<id>` |
| `jobs` collection, "kick" | Done in the request, or the worker is woken |

Links in e-mails sent by the Firebase build point at the old hosts and keep working only while
those stay up. Existing Firestore data is not migrated by this repository.
