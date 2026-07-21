// scripts/generate-digest.mjs
//
// Weekly Melbourne real estate news digest for AJ Lee Property Group.
// 1. Pulls recent items from a list of property-news RSS feeds
// 2. Filters/ranks for Melbourne relevance
// 3. Asks Claude to pick the top 3 landlord-relevant stories and draft a
//    STANDALONE blog post + STANDALONE social caption for EACH story,
//    citing the source
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
  // "https://www.smartpropertyinvestment.com.au/rss" — confirmed 404, removed. Swap in a replacement here if you find a good one.
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
      console.warn(`Feed failed, skipping: ${url}\n  -> ${err.message}`);
    }
  }
  return items;
}

function isRecent(item) {
  if (!item.pubDate) return true;
  const ageDays = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= MAX_ITEM_AGE_DAYS;
}

function relevanceScore(item) {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  let score = 0;
  for (const kw of RELEVANCE_KEYWORDS) if (text.includes(kw)) score += 1;
  if (text.includes("melbourne")) score += 5;
  return score;
}

function pickCandidates(items, max = 12) {
  const seen = new Set();
  return items
    .filter(isRecent)
    .filter((it) => it.title && it.link)
    .filter((it) => {
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
  const anthropic = new Anthropic();

  const candidateList = candidates
    .map((c, i) => `${i + 1}. "${c.title}" — ${c.link}\n   ${c.snippet}`)
    .join("\n\n");

  const system = `You write weekly content for AJ Lee Property Group, a Melbourne residential property management company whose audience is landlords/investors.
Brand voice: warm, community-oriented, conversational, scroll-stopping but grounded — never hypey or salesy.
You ONLY use the candidate articles provided. Never invent a story, statistic, or URL that isn't in the candidate list.
Every story you pick must be Melbourne-relevant (either explicitly about Melbourne, or clearly applicable to Melbourne landlords, e.g. a national RBA rate decision).

You are producing THREE fully independent content packages — one per story. Each package stands alone: its own blog post AND its own social caption, so they can be published separately on different days if needed. Do not write one combined blog or one combined caption.

Respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:
{
  "week_of": "string, e.g. July 21, 2026",
  "posts": [
    {
      "headline": "short news headline for this story",
      "source_name": "publication name",
      "source_url": "exact URL from the candidate list",
      "blog_title": "a standalone blog post title for this one story",
      "blog_paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3 with a closing thought"],
      "caption_text": "a standalone social caption for this one story, 1 short paragraph, 1-2 emoji, ends with a light call to comment/engage",
      "hashtags": "space-separated hashtags starting with #, include #AJLeePropertyGroup"
    }
  ]
}
"posts" must have exactly 3 items, ranked most important first. Each blog_paragraphs array should have 3-4 entries forming a complete, standalone short blog post (not a fragment of a bigger piece).`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system,
    messages: [
      {
        role: "user",
        content: `Here are this week's candidate articles:\n\n${candidateList}\n\nPick the 3 best for Melbourne landlords and draft the JSON.`,
      },
    ],
  });

  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Raw Claude response that failed to parse:\n", text);
    throw err;
  }
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
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "3 Melbourne stories, each with its own blog post + social caption", italics: true, color: "666666", size: 20 })],
      spacing: { after: 400 },
    }),
  ];

  digest.posts.forEach((post, i) => {
    children.push(
      new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } }, spacing: { before: i === 0 ? 0 : 300, after: 300 }, children: [] }),
      new Paragraph({ text: `Story ${i + 1}: ${post.headline}`, heading: HeadingLevel.HEADING_1 }),

      new Paragraph({
        children: [new TextRun({ text: `Blog Post ${i + 1}`, bold: true, size: 22, color: "1155CC" })],
        spacing: { before: 100, after: 100 },
      }),
      new Paragraph({ children: [new TextRun({ text: post.blog_title, bold: true, size: 26 })], spacing: { after: 200 } }),
    );

    post.blog_paragraphs.forEach((para) => {
      children.push(new Paragraph({ children: [new TextRun({ text: para })], spacing: { after: 200 } }));
    });

    children.push(
      sourceLine(post.source_name, post.source_url),

      new Paragraph({
        children: [new TextRun({ text: `Social Caption ${i + 1}`, bold: true, size: 22, color: "1155CC" })],
        spacing: { before: 200, after: 100 },
      }),
      new Paragraph({ children: [new TextRun({ text: post.caption_text })], spacing: { after: 100 } }),
      new Paragraph({ children: [new TextRun({ text: post.hashtags, italics: true, color: "666666" })], spacing: { after: 200 } }),
    );
  });

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

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || "onboarding@resend.dev",
    to: process.env.EMAIL_TO,
    subject: `AJ Lee Weekly Real Estate Digest — Week of ${weekOf}`,
    html: `<p>This week's AJ Lee Property Group Melbourne real estate digest is attached — 3 stories, each with its own blog post and social caption, ready to review.</p>`,
    attachments: [{ filename: "AJ-Lee-Weekly-News-Digest.docx", content: fileBuffer }],
  });

  if (error) {
    throw new Error(`Resend failed to send: ${JSON.stringify(error)}`);
  }
  console.log("Email sent, Resend id:", data?.id);
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
