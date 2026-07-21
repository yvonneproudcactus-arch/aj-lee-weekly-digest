// scripts/generate-digest.mjs
//
// Weekly Melbourne real estate news digest for AJ Lee Property Group.
// 1. Pulls recent items from a list of property-news RSS feeds
// 2. Filters/ranks for Melbourne relevance
// 3. Asks Claude to pick the top 3 landlord-relevant stories and draft a
//    blog post + social caption, citing each source
// 4. Builds a .docx with clickable source links
// 5. Emails the .docx via Resend
//
// Required environment variables (set as GitHub Actions secrets):
//   ANTHROPIC_API_KEY   - from console.anthropic.com
//   RESEND_API_KEY      - from resend.com
//   EMAIL_TO            - where the weekly doc should land
//   EMAIL_FROM          - optional, defaults to onboarding@resend.dev

import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle, ExternalHyperlink,
} from "docx";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 1. CONFIG — edit this list any time a feed goes stale or you find a better one
// ---------------------------------------------------------------------------

const FEEDS = [
  "https://propertyupdate.com.au/feed/",
  "https://www.smartpropertyinvestment.com.au/rss",
  // Broad fallback via Google News so there's always *something* to work with
  "https://news.google.com/rss/search?q=Melbourne%20real%20estate%20OR%20rental%20OR%20property%20when:7d&hl=en-AU&gl=AU&ceid=AU:en",
];

const RELEVANCE_KEYWORDS = [
  "melbourne", "victoria", "vic ", "vacancy", "rent", "landlord", "tenant",
  "investor", "cash rate", "rba", "interest rate", "median price", "auction",
  "property market", "real estate",
];

const MAX_ITEM_AGE_DAYS = 10;

// ---------------------------------------------------------------------------
// 2. FETCH + FILTER
// ---------------------------------------------------------------------------

async function fetchAllFeeds() {
  const parser = new Parser({ timeout: 15000 });
  const items = [];

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items ?? []) {
        items.push({
          title: item.title?.trim() ?? "",
          link: item.link?.trim() ?? "",
          snippet: (item.contentSnippet || item.content || "").slice(0, 500),
          pubDate: item.pubDate ? new Date(item.pubDate) : null,
          sourceFeed: feed.title || url,
        });
      }
      console.log(`Fetched ${feed.items?.length ?? 0} items from ${url}`);
    } catch (err) {
      // A stale/broken feed shouldn't kill the whole run — log and move on.
      console.warn(`Feed failed, skipping: ${url}\n  -> ${err.message}`);
    }
  }
  return items;
}

function isRecent(item) {
  if (!item.pubDate) return true; // keep undated items rather than drop them
  const ageDays = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= MAX_ITEM_AGE_DAYS;
}

function relevanceScore(item) {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  let score = 0;
  for (const kw of RELEVANCE_KEYWORDS) if (text.includes(kw)) score += 1;
  if (text.includes("melbourne")) score += 5; // heavily favour explicit Melbourne mentions
  return score;
}

function pickCandidates(items, max = 12) {
  const seen = new Set();
  return items
    .filter(isRecent)
    .filter((it) => it.title && it.link)
    .filter((it) => {
      // de-dupe near-identical titles across feeds
      const key = it.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((it) => ({ ...it, score: relevanceScore(it) }))
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// 3. ASK CLAUDE TO SELECT + DRAFT
// ---------------------------------------------------------------------------

async function draftDigest(candidates) {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const candidateList = candidates
    .map((c, i) => `${i + 1}. "${c.title}" — ${c.link}\n   ${c.snippet}`)
    .join("\n\n");

  const system = `You write weekly content for AJ Lee Property Group, a Melbourne residential property management company whose audience is landlords/investors.
Brand voice: warm, community-oriented, conversational, scroll-stopping but grounded — never hypey or salesy.
You ONLY use the candidate articles provided. Never invent a story, statistic, or URL that isn't in the candidate list.
Every story you pick must be Melbourne-relevant (either explicitly about Melbourne, or clearly applicable to Melbourne landlords, e.g. a national RBA rate decision).
Respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:
{
  "week_of": "string, e.g. July 21, 2026",
  "stories": [
    {"headline": "string", "summary": "2-3 sentences", "source_name": "publication name", "source_url": "exact URL from the candidate list"}
  ],
  "blog": {
    "title": "string",
    "intro": "1-2 sentences",
    "sections": [
      {"body": "1 paragraph expanding on story 1, matches stories[0]", "source_url": "same URL as stories[0].source_url"},
      {"body": "1 paragraph expanding on story 2, matches stories[1]", "source_url": "same URL as stories[1].source_url"},
      {"body": "1 paragraph expanding on story 3, matches stories[2]", "source_url": "same URL as stories[2].source_url"}
    ],
    "closing": "1-2 sentences wrapping up with a call to think about their own portfolio"
  },
  "caption": {
    "text": "1 short paragraph, landlord-facing, includes 1-2 emoji, ends with a light call to comment/engage",
    "hashtags": "space-separated hashtags starting with #, include #AJLeePropertyGroup"
  }
}
"stories" must have exactly 3 items, ranked most important first.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    system,
    messages: [
      {
        role: "user",
        content: `Here are this week's candidate articles:\n\n${candidateList}\n\nPick the 3 best for Melbourne landlords and draft the JSON.`,
      },
    ],
  });

  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 4. BUILD THE DOCX
// ---------------------------------------------------------------------------

function sourceLine(label, url) {
  return new Paragraph({
    spacing: { after: 200 },
    children: [
      new TextRun({ text: "Source: ", italics: true, color: "666666", size: 20 }),
      new ExternalHyperlink({
        link: url,
        children: [new TextRun({ text: label, italics: true, color: "1155CC", size: 20, underline: {} })],
      }),
    ],
  });
}

async function buildDocx(digest, outPath) {
  const children = [
    new Paragraph({ text: "AJ Lee Property Group", heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: "Weekly Real Estate News Digest", bold: true, size: 28 })],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Week of ${digest.week_of}`, italics: true, color: "666666" })],
      spacing: { after: 400 },
    }),
    new Paragraph({ text: "This Week's Top 3 Melbourne Stories for Landlords", heading: HeadingLevel.HEADING_1 }),
  ];

  digest.stories.forEach((s, i) => {
    children.push(
      new Paragraph({
        spacing: { before: 200 },
        children: [new TextRun({ text: `${i + 1}. ${s.headline}`, bold: true, size: 24 })],
      }),
      new Paragraph({ children: [new TextRun({ text: s.summary })], spacing: { after: 100 } }),
      sourceLine(s.source_name, s.source_url),
    );
  });

  children.push(
    new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } }, spacing: { after: 300 }, children: [] }),
    new Paragraph({ text: "Blog Draft", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: digest.blog.title, bold: true, size: 26 })], spacing: { after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: digest.blog.intro })], spacing: { after: 200 } }),
  );

  digest.blog.sections.forEach((sec) => {
    const story = digest.stories.find((s) => s.source_url === sec.source_url);
    children.push(
      new Paragraph({ children: [new TextRun({ text: sec.body })], spacing: { after: 100 } }),
      sourceLine(story?.source_name ?? "Source", sec.source_url),
    );
  });

  children.push(
    new Paragraph({ children: [new TextRun({ text: digest.blog.closing })], spacing: { after: 400 } }),
    new Paragraph({ text: "Social Caption Draft", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: digest.caption.text })], spacing: { after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: digest.caption.hashtags, italics: true, color: "666666" })] }),
  );

  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 } } }, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

// ---------------------------------------------------------------------------
// 5. EMAIL IT
// ---------------------------------------------------------------------------

async function emailDigest(outPath, weekOf) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fileBuffer = fs.readFileSync(outPath);

  await resend.emails.send({
    from: process.env.EMAIL_FROM || "onboarding@resend.dev",
    to: process.env.EMAIL_TO,
    subject: `AJ Lee Weekly Real Estate Digest — Week of ${weekOf}`,
    html: `<p>This week's AJ Lee Property Group Melbourne real estate digest is attached — top 3 stories, a blog draft, and a social caption, ready to review.</p>`,
    attachments: [{ filename: "AJ-Lee-Weekly-News-Digest.docx", content: fileBuffer }],
  });
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log("Fetching feeds...");
  const rawItems = await fetchAllFeeds();
  console.log(`Total raw items: ${rawItems.length}`);

  const candidates = pickCandidates(rawItems);
  console.log(`Candidates after filtering/ranking: ${candidates.length}`);
  if (candidates.length < 3) {
    throw new Error("Not enough relevant candidate articles this week — check feed health in the log above.");
  }

  console.log("Asking Claude to pick + draft...");
  const digest = await draftDigest(candidates);

  const outPath = "AJ-Lee-Weekly-News-Digest.docx";
  console.log("Building docx...");
  await buildDocx(digest, outPath);

  console.log("Emailing digest...");
  await emailDigest(outPath, digest.week_of);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
