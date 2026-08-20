# Samyou USA — HVAC Requirement Questionnaire

A single Node app that **serves the questionnaire page** and **handles submissions**
(saves to Supabase + emails you via Mailgun). Designed to run on **Railway** and live at
**requirements.samyouusa.com**, linked from your WordPress site.

---

## What's in this folder

```
samyou-hvac-questionnaire/
├─ server.js            ← the Node server (zero dependencies)
├─ package.json         ← tells Railway how to start it
├─ railway.json         ← Railway build/health config
├─ .env.example         ← the environment variables you'll set in Railway
├─ .gitignore
├─ SETUP-GUIDE.md       ← this file
└─ public/
   ├─ index.html        ← the questionnaire (all styling + logic)
   ├─ HVAC_Development_Requirement_Checklist_English.xlsx   ← Excel template
   └─ og.png            ← social-share preview image
```

You will do five things: **(1)** create the Supabase table, **(2)** get your Supabase +
Mailgun keys, **(3)** deploy to Railway, **(4)** point the subdomain at Railway, **(5)** add
the link in WordPress. About 20–30 minutes total.

---

## Step 1 — Create the Supabase table

Open your Supabase project → **SQL Editor** → **New query**, paste this, and click **Run**:

```sql
create table if not exists public.hvac_submissions (
  id              bigint generated always as identity primary key,
  submission_id   text unique not null,
  submitted_at    timestamptz,
  project_name    text,
  contact_name    text,
  company         text,
  email           text,
  phone           text,
  country         text,
  sales_territory text,
  capacities      text,
  construction    text,
  operating_mode  text,
  refrigerant     text,
  certifications  text,
  annual_demand   text,
  status          text default 'New',
  data            jsonb,
  created_at      timestamptz default now()
);

-- Lock it down: only your server's service-role key can read/write.
-- The public anon key cannot touch this table.
alter table public.hvac_submissions enable row level security;
```

That's it — no policies are needed, because the server uses the **service role** key, which
bypasses row-level security. Enabling RLS with no policies means nobody else can read it.

Your full submissions live in **Table Editor → hvac_submissions**. The `data` column holds the
complete answer set as JSON; the other columns are the key fields for quick filtering.

---

## Step 2 — Collect your keys

**Supabase** (dashboard → **Project Settings → API**):

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Already yours: `https://jihbtcodhazjxqkrwyeu.supabase.co` |
| `SUPABASE_SERVICE_KEY` | "Project API keys" → **service_role** → *Reveal* and copy. **Secret — never put in the page.** |

**Mailgun** (you mentioned you use it):

1. Add/verify a sending domain (e.g. `mg.samyouusa.com`) under **Sending → Domains**, following
   Mailgun's DNS records. (A subdomain like `mg.` is the usual choice and won't affect your main email.)
2. Copy your **private API key** (Mailgun → **Send → API keys**, or account API security settings).
3. Decide the **From** and **To** addresses.

| Variable | Example |
|---|---|
| `MAILGUN_API_KEY` | your private key |
| `MAILGUN_DOMAIN` | `mg.samyouusa.com` |
| `MAILGUN_REGION` | `us` (or `eu` if your Mailgun account is EU) |
| `MAIL_FROM` | `HVAC Requests <requests@mg.samyouusa.com>` |
| `MAIL_TO` | `buzzardontree@gmail.com` (comma-separate for multiple) |

> The app works even if a piece is missing — if Mailgun isn't set, it just skips the email and
> still saves to Supabase (and vice-versa). Nothing breaks for the visitor; they always get their Excel.

---

## Step 3 — Deploy to Railway

**Easiest (GitHub):**

1. Put this folder in a GitHub repo (drag the files into a new repo, or `git init && git push`).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node and runs `npm start`. First deploy takes ~1 minute.

**Or with the Railway CLI:**

```bash
npm i -g @railway/cli
railway login
cd samyou-hvac-questionnaire
railway init        # create a new project
railway up          # deploy
```

**Set the environment variables:** in Railway → your service → **Variables**, add every key from
`.env.example` (Step 2 values). Railway redeploys automatically. You can paste them all at once
using Railway's "Raw editor".

**Get the URL:** Railway → service → **Settings → Networking → Generate Domain**. You'll get
something like `samyou-hvac-questionnaire-production.up.railway.app`. Open it — the questionnaire
should load. Do a test submission (see Step 5's checklist).

---

## Step 4 — Point requirements.samyouusa.com at Railway

Right now the subdomain you created points to Hostinger. To serve it from Railway instead:

1. Railway → service → **Settings → Networking → Custom Domain** → enter
   `requirements.samyouusa.com`. Railway shows you a **CNAME target** (e.g. `abcd1234.up.railway.app`).
2. In **Hostinger → hPanel → Domains → DNS / Nameservers → DNS Zone** for `samyouusa.com`:
   - **Delete** any existing record for the `requirements` subdomain (Hostinger likely created an
     `A` record when you made the subdomain).
   - **Add a CNAME**: Name = `requirements`, Target/Points to = the Railway target from step 1, TTL default.
3. Wait for DNS to propagate (usually minutes, up to an hour). Railway will show the domain as
   **Active** and issue an HTTPS certificate automatically.

> Your WordPress site and main domain are untouched — this only changes the one `requirements` subdomain.

---

## Step 5 — Add the link in WordPress

You're **linking** to the page (not embedding it), so this is just a menu item or button:

**As a menu item:** WordPress admin → **Appearance → Menus** → **Add menu item → Custom Links** →
URL `https://requirements.samyouusa.com`, Link Text `Start a Project` → **Add to Menu** → **Save**.

**As a button** (in any page/post with the block editor): add a **Button** block → label it
`Start a Project` → set the link to `https://requirements.samyouusa.com` → (optional) open in new tab.

Tip: to match your site's red, give the button your brand color **#BC132E**.

### Post-launch checklist
- [ ] Open `https://requirements.samyouusa.com` — page loads over HTTPS, logo + red styling show.
- [ ] Fill the form and submit — you get the **Excel download** and the on-screen **submission ID**.
- [ ] A new row appears in Supabase **hvac_submissions**.
- [ ] The notification **email** arrives at your `MAIL_TO` address.
- [ ] The **Start a Project** link works from WordPress.

---

## Good to know

- **Fonts:** headings use **Montserrat** (Google Fonts) to match samyouusa.com; body text uses the
  visitor's system font. No MiSans, per your preference.
- **Logo:** loaded directly from your main site
  (`samyouusa.com/.../…188x88.png`). If you ever change it there, update the `<img>` src in
  `public/index.html`.
- **Excel:** generated in the visitor's browser from `public/HVAC_Development_Requirement_Checklist_English.xlsx`
  using ExcelJS (loaded from cdnjs). To change the output, replace that template file (keep the cell
  layout) — the field-to-cell mapping lives in `public/index.html` (`buildWorkbook`).
- **Spam:** a hidden honeypot field silently drops bot submissions. Required-field + email checks run
  on the server.
- **Security:** all secret keys live only in Railway's environment variables — never in the page or repo.
- **Reliability:** email and database writes are independent — if one has a hiccup, the other still
  succeeds and the visitor still gets their Excel. Errors are written to the Railway logs.
