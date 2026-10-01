# Emailing Portal: zero-cost email marketing on Google

A complete email marketing system that runs entirely on Google's free tiers. It needs no servers and no billing account.

| Feature | Details |
|---|---|
| **Email builder** | A drag-and-drop block editor with headings, text, images uploaded to Google Drive, buttons, 2 columns, dividers, spacers, social links, footer and custom HTML. Text can be edited inline, with desktop and mobile preview. There is also an **HTML code editor** with live preview, snippets and `.html` import. |
| **Standard templates** | Newsletter, Promotion, Welcome, Event invitation, Personal follow-up and Reply auto-response. |
| **Contacts & lists** | CSV import with automatic column detection and merge on duplicates, tags, country and industry, filters, bulk actions, CSV export. |
| **Lead Finder** | Search online by **country** (54) and **industry** (32, plus custom). Sources: web search (DuckDuckGo, or Google Programmable Search) followed by a polite, robots.txt-aware crawl of company websites. Optional **Hunter.io** and **Apollo.io** portals, or crawl a list of websites you supply. You review results and import them into a list. |
| **Campaigns** | Personalisation (`{{first_name\|there}}`, `{{company}}`…), test sends, send now or schedule, daily and per-batch limits, pause and resume. |
| **Tracking** | Opens, clicks (with a top-links report), replies, one-click unsubscribe (`List-Unsubscribe` + RFC 8058) and bounces. |
| **Reply detection** | Reads your **Gmail inbox** directly and matches each reply to the email it answers by Gmail thread. No IMAP setup needed. |
| **Automations** | **Triggers:** email sent, opened, link clicked, **reply received** (optionally filtered by keywords), added to list, manual. **Steps:** wait, send email (optionally threaded as "Re:"), stop if replied / opened / clicked, add or remove tags and lists, update a field, notify your team, webhook. An automation can also stop as soon as the contact replies. |

## Architecture (all free)

```
   Browser (dashboard)                 Recipients
        │  Google sign-in                │ open pixel        │ click / unsubscribe
        ▼                                ▼                   ▼
 ┌──────────────────┐    ┌──────────────────────────┐   ┌───────────────────────┐
 │ Firebase Hosting │    │ Google Apps Script       │   │ Firebase Hosting      │
 │ hosting/ (SPA)   │◄──►│ web app + 5-min trigger  │   │ r.html / u.html       │
 └────────┬─────────┘    │  • sends via Gmail       │   └──────────┬────────────┘
          │              │  • reads replies (Gmail) │              │
          ▼              │  • automations, leads    │              ▼
 ┌──────────────────┐    │  • images → Google Drive │   ┌───────────────────────┐
 │ Cloud Firestore  │◄──►│                          │   │ Firestore (clicks,    │
 │ (all data)       │    └──────────────────────────┘   │ unsubscribes, links)  │
 └──────────────────┘                                   └───────────────────────┘
```

- **Firebase Hosting** serves the dashboard and the public click-redirect (`r.html`) and unsubscribe (`u.html`) pages.
- **Firebase Authentication** handles Google sign-in. Only accounts listed in Firestore `admins/` can use the dashboard, and **Firestore security rules** enforce this.
- **Cloud Firestore** stores contacts, lists, templates, campaigns, messages, automations, replies and leads.
- **Google Apps Script** (`apps-script/`) is the free backend worker. It runs as **your Google account**, so it:
  - sends email through **Gmail**;
  - reads replies from your inbox;
  - runs automations and the lead crawler;
  - stores uploaded images in **Google Drive**;
  - serves the open-tracking pixel.

  A time trigger runs it every 5 minutes. The dashboard can also wake it instantly.

Everything stays on the **Spark (free) plan**. Cloud Functions and Cloud Storage are not used, because they require the paid Blaze plan.

### Free-tier limits to know

| Service | Free allowance (approx.) |
|---|---|
| Gmail sending (via Apps Script) | ~100 recipients/day on free Gmail; ~1,500/day on Google Workspace |
| Apps Script | 90 min/day total trigger runtime (free Gmail), 6 h/day (Workspace); 6 min per run; 20,000 URL fetches/day |
| Firestore | 50,000 reads, 20,000 writes and 20,000 deletes per day; 1 GiB storage |
| Hosting | 10 GB storage, 360 MB/day transfer |
| Google Programmable Search (optional) | 100 queries/day |

Large campaigns are not lost when they hit the daily cap: they keep sending automatically over the following days. Set your caps in **Settings → Sending limits**. For higher volume, use a Google Workspace account.

## Deploy (about 15 minutes, all in the browser)

Use the **same Google account** for every step: the one that owns the `emailing-portal` Firebase project. Your console link used `/u/2/`, which is the third account signed in to your browser.

### 1. Prepare the Firebase project

In the [Firebase console](https://console.firebase.google.com/project/emailing-portal/overview), stay on the free **Spark** plan and do the following:

1. **Build → Firestore Database → Create database.** Choose *production mode* and a region near you (for example `asia-southeast1`).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
3. **Project settings (⚙) → General → Your apps → Add app → Web (`</>`).** Name it "Emailing Portal" and click Register. You don't need to copy the config: Hosting provides it automatically.

### 2. Deploy the website, security rules and indexes

Open **[Google Cloud Shell](https://shell.cloud.google.com/)**. It's free, browser-based, and has Node.js, git and the Firebase CLI installed. Then run:

```bash
git clone https://github.com/grandpinecapital/Emailing.git
cd Emailing
git checkout claude/vigilant-noether-4p9j69   # or main, once merged
npx -y firebase-tools@latest login --no-localhost
npx -y firebase-tools@latest deploy --only hosting,firestore --project emailing-portal
```

The dashboard is now at **https://emailing-portal.web.app**. Sign-in won't work yet, because the worker still needs to create your admin record.

### 3. Deploy the Apps Script worker

1. Turn on the Apps Script API at <https://script.google.com/home/usersettings>.
2. In Cloud Shell, run:

   ```bash
   cd apps-script
   npx -y @google/clasp@latest login --no-localhost
   npx -y @google/clasp@latest create --type standalone --title "Emailing Worker" --rootDir .
   git checkout -- appsscript.json             # clasp create may overwrite the manifest; restore ours
   npx -y @google/clasp@latest push -f
   npx -y @google/clasp@latest open-script   # prints the editor URL
   ```

3. In the Apps Script editor, click **Deploy → New deployment → ⚙ Web app**. Set *Execute as* to **Me** and *Who has access* to **Anyone**, then click Deploy and authorise.

   Google shows "Google hasn't verified this app" because the script is your own. Click **Advanced → Go to Emailing Worker**.
4. In the function dropdown, choose **`setup`** and click **Run**. The log should say `Setup complete`. This:
   - makes your account an admin;
   - saves the web app URL;
   - creates the standard templates and example automations;
   - installs the 5-minute trigger.
5. Open **https://emailing-portal.web.app**, sign in with Google, then go to **Settings**. Check that *Apps Script web app URL* matches the URL from the deployment dialog (it ends in `/exec`; paste it if it's empty), then click **Check worker connection**.

To add more dashboard users, run `addAdmin("colleague@example.com")` in the Apps Script editor, or create a document `admins/<email>` in Firestore.

### Updating later

```bash
git pull
npm run deploy        # sync shared code, deploy Hosting + rules, push Apps Script
```

If you change `doGet`/`doPost`, also update the web app version: **Deploy → Manage deployments → ✎ → Version: New version**.

### Troubleshooting

- **"Cloud Firestore API has not been used in project …" or 403 errors in the Apps Script log.**
  1. In Firebase Project settings, copy the **project number**.
  2. In Google Cloud console → *APIs & Services → OAuth consent screen*, configure an *External* consent screen and add yourself as a test user.
  3. In the Apps Script editor, go to *Project settings → Google Cloud Platform project → Change project* and paste the number.
  4. Re-run `setup`.
- **"The query requires an index"**: run `npx firebase-tools deploy --only firestore:indexes`. You can also open the link in the error to create the index.
- **Sign-in says you're not an admin**: run `setup()` with the account you sign in with, or `addAdmin("you@…")`.
- **Nothing sends**: check **Settings** for the last worker run, dry-run mode and today's remaining quota. In Apps Script, check *Triggers* (a `tick` trigger every 5 minutes) and *Executions*.

## Using it

1. **Settings**: set your sender name, company postal address (required by anti-spam law) and daily limits.
2. **Contacts**: import a CSV. Or use **Lead Finder**: pick countries and industries, start the search (the worker crawls in the background), review the results, then import them into a list.
3. **Templates**: start from a standard template or build your own with drag and drop or HTML.
4. **Campaigns**: choose lists and a template, send a test, then **Send now** or **Schedule**.
5. **Automations**: open an example, choose its templates or campaign, and click **Save & activate**. For example:
   - *Follow up if no reply after 3 days*: email sent → wait 3 days → stop if replied → send follow-up in the same thread.
   - *Auto-respond & notify team on reply*: reply received → tag → "thanks" email → notify you.
   - *Hot lead*: reply contains "pricing, quote, meeting" → tag `hot-lead` → notify.

**How tracking works:**
- **Opens:** a 1×1 pixel served by the Apps Script web app.
- **Clicks:** links go through `https://emailing-portal.web.app/r.html`. It records the click in Firestore, then redirects only to URLs your own emails contained.
- **Unsubscribes:**
  - the `u.html` page;
  - Gmail's one-click unsubscribe button;
  - replying with "unsubscribe".

  Unsubscribed and bounced contacts are skipped and removed from running automations.

## Compliance

Every email carries an unsubscribe link (added automatically if your template lacks one) and a `List-Unsubscribe` header. Only email people you have a lawful basis to contact. Follow the rules where you send: **GDPR** (EU/UK), **PDPA** (Malaysia/Singapore), **CAN-SPAM** (US) and **CASL** (Canada). The Lead Finder collects only publicly listed business addresses, honours `robots.txt` and identifies itself with a configurable User-Agent. Sending cold email from a personal Gmail account at volume can get the account restricted, so start small and warm up.

## Repository layout

```
firebase.json, .firebaserc        Firebase project config (project: emailing-portal)
firestore.rules                   security rules (admins only; public pages may only create clicks/unsubscribes)
firestore.indexes.json            composite indexes used by the dashboard and worker
hosting/                          Firebase Hosting site
  index.html, js/app.js           dashboard shell, router, UI helpers
  js/builder.js                   drag & drop + HTML template editor
  js/views.js                     all other screens
  js/backend.js                   data layer: Firestore queries + calls to the worker
  js/firebase.js, js/main.js      Firebase init (config from /__/firebase/init.json), Google sign-in
  r.html, u.html, js/public.js    public click-redirect and unsubscribe pages
apps-script/                      Google Apps Script worker (deploy with clasp)
  Code.js                         setup(), tick(), doGet/doPost, jobs
  Firestore.js                    Firestore REST client
  Mailer.js, Delivery.js          Gmail sending (raw MIME), personalisation and tracking
  Campaigns.js, Automations.js    queueing and the automation engine
  Replies.js, Tracking.js         Gmail reply/bounce/unsubscribe detection, opens and clicks
  Leads.js                        lead finder (search, crawler, Hunter, Apollo)
shared/                           code shared by browser + Apps Script (copied by `npm run sync`)
test/                             unit tests, Apps Script worker tests, full-stack e2e test
```

## Tests

```bash
npm test          # shared modules + the Apps Script worker run in Node against a fake Firestore/Gmail
```

There is also a full-stack test. It drives the real dashboard in Chromium against the Firebase emulators, with the Apps Script worker code talking to the Firestore emulator:

```bash
npm run emulators                                        # terminal 1
npm i --no-save firebase@12.19.0 esbuild playwright      # terminal 2
npx playwright install chromium
npm run test:e2e
```

The previous self-hosted Node.js/SQLite version is in this repository's git history (commit "Add end-to-end email marketing system").
