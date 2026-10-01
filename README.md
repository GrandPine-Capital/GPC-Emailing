# Emailing — end-to-end email marketing system

A self-hosted email marketing platform:

| Area | What you get |
|---|---|
| **Email builder** | A drag-and-drop block editor with headings, text, images (with upload), buttons, 2 columns, dividers, spacers, social links, footer and custom HTML. It has inline text editing and desktop/mobile preview. There is also an **HTML code editor** with live preview, snippets and `.html` import. Output is table-based, email-client-safe HTML. |
| **Standard templates** | Ready-made templates: Newsletter, Promotion, Welcome, Event invitation, Personal follow-up and Reply auto-response. You can duplicate or edit any of them. |
| **Contacts & lists** | Import from CSV (headers are detected automatically and duplicates are merged). You can add contacts manually, tag them, filter by list, country, industry, tag or status, run bulk actions and export to CSV. |
| **Lead Finder** | Search online by **country** and **industry** (54 countries, 32 industries, plus custom industries and keywords). Sources: web search (DuckDuckGo, or Google Programmable Search) followed by a polite crawl of company websites; **Hunter.io** and **Apollo.io** portals; or crawl a list of websites you supply. You review the results and import them into a list. |
| **Campaigns** | Send to one or more lists with personalisation (`{{first_name\|there}}`, `{{company}}`…). You can send a test, send now or schedule. Sending is rate-limited, and you can pause or resume. |
| **Tracking** | Open pixel, signed click-tracking redirects, one-click unsubscribe (`List-Unsubscribe` + RFC 8058), and per-campaign reports covering opens, clicks, replies, top links and recipients. |
| **Reply detection** | Polls your IMAP mailbox, or accepts an inbound webhook (SendGrid Inbound Parse, Mailgun Routes, Postmark). Each reply is matched to the exact email it answers via `In-Reply-To`/`References`, with a fallback match on the sender's address. |
| **Automations** | Triggers: *email sent*, *opened*, *link clicked*, **reply received** (optionally filtered by keywords), *added to list*, *manual*. Steps: wait, send email (optionally threaded as "Re:"), stop-if (replied, opened, clicked…), add or remove tags and lists, update a field, notify your team, call a webhook. An automation can also stop as soon as the contact replies. |

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native modules to build).

```bash
npm install
cp .env.example .env       # optional – everything can also be set in the Settings page
npm start                  # http://localhost:3000
```

If no SMTP host is configured, the app runs in **dry-run mode**: emails are rendered, recorded and tracked, but not delivered. This lets you try everything safely. When you're ready to send for real, add SMTP and IMAP under **Settings**.

Set `ADMIN_PASSWORD` (HTTP Basic auth) and `APP_SECRET` before exposing the app to the internet. Set `BASE_URL` to the app's public URL so that tracking, unsubscribe links and uploaded images work for recipients.

### Typical workflow

1. **Settings**: configure the sender, SMTP (outgoing), IMAP (replies) and your company address.
2. **Contacts**: import a CSV. Or use **Lead Finder**: pick countries and industries, run the search, review, then import into a list.
3. **Templates**: start from a standard template or build your own with drag and drop or HTML.
4. **Campaigns**: choose the lists and the template, send a test, then send now or schedule.
5. **Automations**: activate (or create) sequences, for example:
   - *Follow up if no reply after 3 days*: email sent → wait 3 days → stop if replied → send follow-up in the same thread.
   - *Auto-respond & notify team on reply*: reply received → tag → send "thanks" email → notify sales.
   - *Hot lead*: reply contains "pricing, quote, meeting" → tag `hot-lead` → notify.

   The seeded examples start **paused**. Open one, choose its templates or campaign, then click *Save & activate*.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT`, `BASE_URL` | Server port and public URL (used in tracking and unsubscribe links) |
| `DATABASE_PATH` | SQLite file (default `./data/emailing.db`) |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Basic auth for the dashboard and API |
| `APP_SECRET` | Signs click-tracking links and the inbound-webhook key |
| `SMTP_*`, `FROM_NAME`, `FROM_EMAIL`, `REPLY_TO` | Outgoing mail |
| `IMAP_*` | Reply detection mailbox |
| `HUNTER_API_KEY`, `APOLLO_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` | Optional lead-finder portals |
| `SEND_RATE_PER_MINUTE` | Sending throttle (default 60) |

Gmail / Google Workspace: SMTP `smtp.gmail.com:465` (SSL on), IMAP `imap.gmail.com:993`, using an *app password*.
Microsoft 365: SMTP `smtp.office365.com:587`, IMAP `outlook.office365.com:993`.

**Inbound webhook (alternative to IMAP):** Settings shows a URL like `https://your-host/api/inbound/reply?key=…`. Point your provider's inbound-parse feature at it.

**Lead Finder notes:** DuckDuckGo's HTML endpoint needs no key, but it can rate-limit or block automated traffic. For reliable results add a Google Programmable Search key, Hunter.io or Apollo.io. The crawler honours `robots.txt`, identifies itself with a configurable User-Agent, waits between requests and visits only a few pages per site (home, contact, about).

## Compliance

Every email gets an unsubscribe link (added automatically if your template lacks one) and a `List-Unsubscribe` header. Unsubscribed contacts are skipped by campaigns and removed from running automations. Before emailing imported or discovered contacts, make sure you have a lawful basis (consent, or legitimate interest for B2B where allowed). Follow the rules where you send: **GDPR** (EU/UK), **PDPA** (Malaysia/Singapore), **CAN-SPAM** (US), **CASL** (Canada). Include your postal address (Settings → Company postal address) and keep sending volumes reasonable.

## Architecture

```
src/
  server.js            entry point (DB init, seed, HTTP server, scheduler)
  app.js               Express app: public routes, basic auth, API, static UI
  db.js                SQLite schema + helpers (node:sqlite)
  seed.js              standard templates & example automations
  scheduler.js         background loop: campaign queue, automation steps, IMAP polling
  lib/
    render-blocks.js   design JSON → email HTML (shared with the browser builder)
    personalize.js     merge tags, unsubscribe link, click/open tracking
    mailer.js          nodemailer transport (SMTP or dry-run)
    delivery.js        render + send one message, record events
    campaigns.js       queueing, rate-limited sending, stats
    automations.js     trigger matching + step engine
    replies.js         IMAP polling, reply matching, quoted-text stripping
    contacts.js        upsert / tags / lists
    leads/             web search, crawler, Hunter/Apollo clients, orchestrator
  routes/
    content.js         templates, uploads, lists, contacts, CSV import/export
    engage.js          campaigns, automations, replies, lead finder, settings, stats
    public.js          /t/o (open), /t/c (click), /u (unsubscribe), inbound webhook
public/                single-page UI (vanilla JS, no build step)
test/                  node:test suites (rendering, end-to-end flow, lead finder)
```

Run the tests with `npm test`.
