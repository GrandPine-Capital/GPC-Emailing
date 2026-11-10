# GPC Emailing

E-mail marketing for **GrandPine Capital**: contacts and lists, a drag-and-drop and HTML
template builder, campaigns with open/click/reply tracking, automations (email, WhatsApp,
ChatDaddy, webhooks), auto-replies to incoming mail, inbound webhooks and a lead finder.

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

The worker steps, in order, each tick (`internal/app/worker.go`): launch due campaigns and
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
hourly. **Dry-run mode** (Settings) records and tracks sends without delivering.

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

GPC-Payment delivers its events to `POST /hooks/payments` (outbox target `emailing`, its
`EMAILING_BASE_URL` and `EMAILING_EVENT_SECRET`), signed like its CRM events: header
`sig` = hex HMAC-SHA256 of the body with `PAYMENT_EVENT_SECRET` (the same value). Each send
is kept in `transactional`, once per event and order, so a retried event sends nothing new;
a failed send is retried by the worker (1, 2, 4 … minutes, 8 tries), and SES bounces and
complaints mark the row. Staff see them at `GET /api/transactional?source=payment&reference=<order id>`
and resend with `POST /api/transactional/{id}/resend`.

The templates are ordinary HTML templates in the dashboard (category *transactional*): edit
the wording there. A template with a key cannot be deleted. Merge tags: `first_name`,
`full_name`, `item`, `amount` (`RM 1,234.50`), `paid_at`, `payment_method`, `order_id`,
`receipt_url`, `instructions_url`, `payment_reference`, `expires_at`, `bank_name`,
`account_name`, `account_number`, `duitnow_id`, `refunded_at`, `company_address`.

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
   optionally `BILLING_FROM_NAME`.

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
| `db/migration` | `V1` schema, `V2` standard templates and (paused) example automations |

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
