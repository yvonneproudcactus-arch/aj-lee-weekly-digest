# AJ Lee Weekly Real Estate Digest — Setup Guide

This runs automatically every Monday morning, pulls Melbourne property news,
drafts a blog + social caption with Claude, builds a Word doc, and emails it
to you — no server required, it runs on GitHub Actions' free tier.

## 1. Create the GitHub repo

1. Go to https://github.com/new, create a new **private** repository (e.g. `aj-lee-weekly-digest`).
2. Upload all the files in this folder to it (drag-and-drop on the GitHub web UI works fine, or `git push` if you're comfortable with git).

## 2. Get an Anthropic API key

1. Go to **https://console.anthropic.com** (this redirects to platform.claude.com) and sign up or log in.
   - This is separate from your regular claude.ai login — it's the developer console.
2. Add a payment method under **Billing** (the API is pay-as-you-go; this digest costs a fraction of a cent per run, so set a small monthly cap like $5–10 for peace of mind).
3. Go to **Settings → API Keys → Create Key**, name it something like `aj-lee-digest`.
4. Copy the key immediately — it starts with `sk-ant-` and is only shown once.

## 3. Get a Resend API key (for sending the email)

1. Go to **https://resend.com** and sign up (free tier: 100 emails/day, no credit card needed).
2. Go to **API Keys → Create API Key**, copy it (starts with `re_`).
3. You can start sending immediately from `onboarding@resend.dev` — no domain setup needed. If you'd rather send from your own domain (e.g. `hello@proudcactusdigital.com.au`), verify that domain under **Domains** in Resend first, then use that address as `EMAIL_FROM` below.

## 4. Add your secrets to GitHub

In your new repo: **Settings → Secrets and variables → Actions → New repository secret**. Add each of these:

| Secret name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the `sk-ant-...` key from step 2 |
| `RESEND_API_KEY` | the `re_...` key from step 3 |
| `EMAIL_TO` | the email address that should receive the weekly doc |
| `EMAIL_FROM` | optional — defaults to `onboarding@resend.dev` if you skip this |

## 5. Test it

Go to the **Actions** tab in your repo → **Weekly AJ Lee Real Estate Digest** →
**Run workflow** → **Run workflow**. This triggers it immediately instead of
waiting for Monday, so you can confirm it works end-to-end. Click into the run
to watch the log — it'll tell you if a news feed failed to load or if
anything else went wrong.

## How it runs going forward

- It fires automatically every **Monday ~7–8am Melbourne time**, no action needed.
- Each run is independent — nothing carries over between weeks, so there's no memory or state to manage.
- Cost: roughly a few cents a month in Claude API usage. Resend and GitHub Actions are free at this volume.

## If a news feed goes stale

Real estate sites occasionally change their RSS feed URLs. If the Action log
shows a feed failing, open `scripts/generate-digest.mjs`, find the `FEEDS`
array near the top, and swap in a working feed URL (most WordPress-based
sites expose one at `<site>/feed/`). The Google News fallback in that list
means the digest should still get an issue-free run even if one feed breaks.

## Adjusting the brand voice or story selection

Open `scripts/generate-digest.mjs` and edit the `system` prompt inside
`draftDigest()` — that's where AJ Lee's tone, Melbourne-relevance rules, and
output format are defined. No other code changes needed.
