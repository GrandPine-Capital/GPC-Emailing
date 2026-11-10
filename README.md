# GPC Emailing

E-mail marketing for **GrandPine Capital**: contacts and lists, a drag-and-drop and HTML
template builder, campaigns with open/click/reply tracking, automations (email, WhatsApp,
ChatDaddy, webhooks), auto-replies to incoming mail, inbound webhooks and a lead finder.

A Go service (`cmd/emailing`) serves the dashboard (`web/`, plain HTML and JavaScript), its
API under `/api`, the public routes that e-mails and other apps reach, and runs the
background worker, over one Postgres database whose schema Flyway owns (`db/migration`).
Mail is sent from, and replies are read from, one connected **Gmail / Google Workspace**
mailbox through the Gmail API.

| Concern | How |
|---|---|
| Staff sign-in | GrandPine staff realm (Keycloak, `gpc-staff`), client `emailing-staging`; the client role is the access level |
| Database | PostgreSQL 17; Flyway migrations in `db/migration` |
| Sending and reading mail | Gmail API, through the mailbox an admin connects in Settings (OAuth refresh token, sealed at rest) |
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
| `admin` | Everything, plus Settings, integration keys and the Gmail connection |
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
        │               │ Gmail API (send, inbox, Send-mail-as)
        ▼               ▼
   PostgreSQL      the connected mailbox
```

The worker steps, in order, each tick (`internal/app/worker.go`): launch due campaigns and
send queued mail within the daily and per-run limits; read new inbox mail (replies, bounces,
"unsubscribe" requests, auto-reply rules, the `email_received` trigger); advance due automation
runs; advance the oldest lead search. A Postgres advisory lock keeps one tick at a time even
while a deploy runs two tasks.

Mail never fails for lack of Gmail: while no mailbox is connected, queued mail waits and
automation sends retry hourly. **Dry-run mode** (Settings) records and tracks sends without
delivering, with or without a mailbox.

## Run it locally

```bash
cp .env.example .env                      # set SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up --build                 # Postgres, Flyway, the service on :8080
```

or against your own Postgres: `make migrate` (or Flyway by hand), then `make run`. With
`AUTH_MODE=dev` the sign-in page takes a token such as `dev:alex:admin` (admin, editor or
viewer).

To send for real locally, create a Google OAuth client (below) with redirect URI
`http://localhost:8080/oauth/google/callback`, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
and connect Gmail in Settings.

Tests: `make test`. The Postgres tests need `TEST_DATABASE_URL` pointing at a server where the
user may `CREATE DATABASE` (each test gets a fresh database with the migrations applied).

## Deploy

`.github/workflows/deploy.yml`: branch `staging` deploys to the GitHub environment `staging`
(https://emailing-staging.grandpine.com), `main` to `prod`. It builds the app image and the
Flyway image, runs the migrations as a one-off Fargate task, then rolls the ECS service.

### One-time setup

1. **Infrastructure** (ValueFarm.Infra): an ECS service, an RDS database, the migrate task
   and DNS, as for the Helpdesk; `terraform output emailing_github_config` lists the GitHub
   environment's secret and variables.
2. **Staff realm client** `emailing-staging` in `gpc-staff` (confidential, standard flow +
   PKCE, redirect `https://emailing-staging.grandpine.com/auth/callback`, post-logout redirect
   `https://emailing-staging.grandpine.com/*`, client roles `admin`, `editor`, `viewer`).
3. **Google OAuth client** in a Google Cloud project with the **Gmail API** enabled: type
   *Web application*, redirect URI `https://emailing-staging.grandpine.com/oauth/google/callback`.
   The consent screen must be **Internal** (Workspace) or **In production**: in *Testing*
   Google expires the refresh token after 7 days and sending stops. The scopes are
   `gmail.send`, `gmail.readonly` and `gmail.settings.basic`.
4. **Service environment**: `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`,
   `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` (see `.env.example`).
5. An admin signs in, opens **Settings → Gmail & worker → Connect Gmail**, signs in to the
   sending mailbox and approves. Sender identities ("Send mail as") load by themselves.

`SETTINGS_ENCRYPTION_KEY` and `PUBLIC_BASE_URL` must stay the same once mail has gone out:
the key signs click-tracking links and seals the Gmail token; the URL is in every tracking
and unsubscribe link.

## Limits

| | |
|---|---|
| Gmail sending | ~500 recipients/day on free Gmail, ~2,000/day on Google Workspace; set **Max emails per day** below it |
| Per worker run | **Max emails per worker run** (default 40) every `WORKER_INTERVAL` |
| Lead finder | DuckDuckGo with no key; Google Programmable Search 100 queries/day free; Hunter.io / Apollo.io with their keys |

Campaigns over the daily cap carry on the next day by themselves.

## Code map

| Path | What |
|---|---|
| `cmd/emailing` | Wiring: config, database, auth, worker, HTTP server |
| `internal/app` | The service: delivery and tracking, campaigns, replies and bounces, automations, auto-replies, webhooks, lead searches, the dashboard's operations, the worker |
| `internal/gmail` | Gmail API client and the OAuth consent flow |
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
| Apps Script worker as the owner's Gmail (5-minute trigger) | The Go worker, Gmail API with the connected mailbox |
| Clicks and unsubscribes queued in Firestore by `r.html` / `u.html` | Recorded at once by `/r` and `/u` (the old paths `/r.html`, `/u.html` still work on this host) |
| Open pixel and one-click unsubscribe on the Apps Script URL | `/o`, `/u1` on `PUBLIC_BASE_URL` |
| Webhooks at `<Apps Script URL>?a=hook&k=…` | `PUBLIC_BASE_URL/hook?k=…`: update ChatDaddy and form/Zapier URLs (Settings shows them) |
| Images in Google Drive | Postgres, `/img/<id>` |
| `jobs` collection, "kick" | Done in the request, or the worker is woken |

Links in e-mails sent by the Firebase build point at the old hosts and keep working only while
those stay up. Existing Firestore data is not migrated by this repository.
