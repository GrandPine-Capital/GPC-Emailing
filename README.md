# Emailing Portal: zero-cost email marketing on Google

A complete email marketing system that runs entirely on Google's free tiers. It needs no servers and no billing account.

| Feature | Details |
|---|---|
| **Email builder** | A drag-and-drop block editor with headings, text, images uploaded to Google Drive, buttons, 2 columns, dividers, spacers, social links, footer and custom HTML. Text can be edited inline, with desktop and mobile preview. There is also an **HTML code editor** with live preview, snippets and `.html` import. |
| **Template library** | 15 ready-made templates for your industries: education enrolment and trial class, investing webinar, investment-tool trial, market newsletter, dental-lab outreach to clinics, dental check-up, numerology workshop, soul & mind programme, personal development launch, corporate talent-development proposal, plain B2B intro, and 3 auto-reply templates. Plus the original standard templates. One click copies a template into your editor. |
| **Contacts & lists** | CSV import with automatic column detection and merge on duplicates, tags, country and industry, filters, bulk actions, CSV export. |
| **Lead Finder** | Search online by **country** (54) and **industry**. Built-in **focus industries**: Education (tuition, e-learning, training providers, early childhood, languages), **Investment Education**, **Investment Tools**, trading courses, wealth management, fintech, **Dental Lab**, **Dental clinics**, orthodontics, dental supplies, **Numerology Education**, metaphysics & feng shui, **Soul & Mind Education**, holistic wellness, **Personal Development Education**, coaching, **Human Development & Talent Management**, leadership & corporate training, psychology & counselling. Each focus industry searches several related phrases (e.g. "dental laboratory", "dental technician", "crown and bridge lab"). Sources: web search plus a polite website crawl, **Hunter.io**, **Apollo.io**, or your own URLs. |
| **Campaigns** | Personalisation (`{{first_name\|there}}`, `{{company}}`…), test sends, send now or schedule, daily and per-batch limits, pause and resume. |
| **Tracking** | Opens, clicks (with a top-links report), replies, one-click unsubscribe (`List-Unsubscribe` + RFC 8058) and bounces. |
| **Reply detection** | Reads your **Gmail inbox** directly and matches each reply to the email it answers by Gmail thread. No IMAP setup needed. |
| **Automations** | Start from **10 ready-made recipes**, then build visually: a step-by-step flow that reads as a sentence ("When a reply mentions pricing → add tag → WhatsApp my sales team"). **Triggers:** email sent, opened, link clicked, reply received (with keywords), bounced, unsubscribed, added to list, tag added, **WhatsApp message received** (ChatDaddy), **webhook received** (forms, Zapier, CRM), manual. **Steps:** send email (any sender address, optionally threaded), **send WhatsApp** (ChatDaddy or WhatsApp Cloud API), **sync contact to ChatDaddy** with tags, wait, stop if replied / opened / clicked / has tag, add or remove tags and lists, update a field, notify your team by email and/or WhatsApp, call a webhook. |
| **Team & access** | Invite users as **Admin** (also manages settings and the team) or **Member** (day-to-day work). They sign in with Google, or with an emailed sign-in link if their address isn't a Google account. Firestore rules enforce the roles. |
| **Sending addresses** | Send from any connected address: Gmail/Workspace aliases or your own domain (e.g. info@yourcompany.com via its SMTP) through Gmail's *Send mail as*. A step-by-step **Connect an email address** guide is built in. Choose the address per campaign, per automation email or per auto-reply. |
| **Auto-reply** | Rules that answer incoming email to your connected addresses: any address or a specific one; everyone, new senders or contacts; optional keywords; always, or only in or outside office hours. Replies come from the address they wrote to, in the same thread, at most once per sender per N hours. Optionally save the sender as a contact (list + tags) and notify your team. Never answers newsletters, no-reply senders, other auto-responders or yourself. An activity log shows what happened to each incoming email. |
| **Mobile** | Fully responsive, with a hamburger menu, bottom tab bar and phone-sized forms and dialogs. |

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

### Optional: WhatsApp, ChatDaddy and email-link sign-in

- **Email-link sign-in** (for users without a Google account): in Firebase console → Authentication → Sign-in method, enable **Email/Password** and turn on **Email link (passwordless sign-in)**.
- **ChatDaddy:**
  1. Create an API token at <https://app.chatdaddy.tech/settings/api> with message and contact scopes.
  2. Paste it in **Settings → WhatsApp & ChatDaddy** and send yourself a test.
  3. To receive WhatsApp replies, add the **ChatDaddy webhook URL** from **Settings → Inbound webhooks** as a ChatDaddy webhook for the `message-insert` event.
- **WhatsApp Cloud API (Meta)**, as an alternative to ChatDaddy: enter the phone number ID and access token. To start conversations, Meta requires pre-approved message templates.
- Set the **default country code** (for example `60`), so local numbers like `012-345 6789` become `60123456789`.

ChatDaddy and Meta bill their own usage. Everything else in this portal stays on Google's free tiers.

### Connecting other email addresses (sending + auto-reply)

All email runs through the worker's Gmail account. Click **Settings → Sender identities → Connect an email address** for the guide. In short:
1. **Send:** add the address in Gmail → Settings → Accounts → *Send mail as*. Use your provider's SMTP for non-Google domains.
2. **Receive:** forward incoming mail from that address to the worker's Gmail.
3. Click **Refresh from Gmail**.

The address can then be used as a sender, and **Auto-reply** rules answer email sent to it.

### Automatic deployment (set up once, then hands-off)

After this, every push to GitHub on `main` or a `claude/...` branch deploys the whole system automatically through GitHub Actions (free):
- runs the tests;
- deploys Hosting and the Firestore rules and indexes;
- pushes and redeploys the Apps Script worker.

The worker then upgrades itself on its next 5-minute run, so you don't need to re-run `setup()`.

One-time setup, in Cloud Shell, after you have done the **Deploy** steps above once:

```bash
cd ~/Emailing && git pull
bash scripts/setup-auto-deploy.sh
```

The script:
1. Creates a `github-deployer` service account in `emailing-portal`.
2. Signs you in to GitHub. Open the link it prints and enter the code.
3. Saves three repository secrets: `FIREBASE_SERVICE_ACCOUNT`, `CLASPRC_JSON` and `CLASP_SCRIPT_ID`.

You can follow each run under your GitHub repository → **Actions**. To deploy without a code change, open **Actions → Deploy → Run workflow**.

If a run's worker step fails with an authentication error, your clasp login has expired. Run `npx -y @google/clasp@latest login --no-localhost` in Cloud Shell, then run `bash scripts/setup-auto-deploy.sh` again.

### Upgrading an existing installation (manual)

```bash
cd ~/Emailing && git pull
npm run deploy        # Hosting + Firestore rules, then push and redeploy the Apps Script worker
```

`npm run deploy:worker` does only the Apps Script part:
1. It pushes the code.
2. It finds your web-app deployment by itself, so you never need to copy a deployment ID.
3. It updates that deployment in place, so the `/exec` URL stays the same.

<details><summary>Doing it by hand instead</summary>

```bash
cd ~/Emailing/apps-script
npx -y @google/clasp@latest push -f
npx -y @google/clasp@latest deployments       # copy the ID on the line ending in "@<number>", NOT "@HEAD"
npx -y @google/clasp@latest redeploy AKfy...the-copied-ID... -d "update"
```
</details>

The worker upgrades itself on its next 5-minute run: it marks you as the owner, creates the webhook secret and loads your Gmail sender identities. You can also run **`setup()`** in the Apps Script editor to do it straight away; it's safe to re-run.

### Updating later

```bash
git pull
npm run deploy        # sync shared code, deploy Hosting + rules, push and redeploy the worker
```

### Troubleshooting

- **"Invalid deployment ID"** from `clasp redeploy`: the deployment ID was wrong or a placeholder. Run `npm run deploy:worker`, which finds the ID for you.

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
  Code.js                         setup(), upgrade(), tick(), doGet/doPost, jobs
  Build.js                        build ID stamped on each deploy (triggers the automatic upgrade)
  Firestore.js                    Firestore REST client
  Mailer.js, Delivery.js          Gmail sending (raw MIME), personalisation and tracking
  Campaigns.js, Automations.js    queueing and the automation engine
  Replies.js, Tracking.js         Gmail reply/bounce/unsubscribe detection, opens and clicks
  Leads.js                        lead finder (search, crawler, Hunter, Apollo)
.github/workflows/deploy.yml      test + deploy everything on every push
scripts/                          sync-shared.js, redeploy-worker.js, setup-auto-deploy.sh
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
