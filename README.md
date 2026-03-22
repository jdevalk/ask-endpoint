# nlweb-cloudflare

An [NLWeb](https://github.com/nlweb-ai/NLWeb)-compatible `/ask` endpoint for static sites on Cloudflare Pages. Adds AI-powered Q&A to any markdown-based site using Cloudflare Workers AI.

## What it does

- **Hybrid search**: keyword scoring + semantic embeddings find relevant content
- **LLM answers**: generates natural language answers grounded in your content
- **Source filtering**: only shows sources the LLM actually referenced in its answer (falls back to all context sources if none linked)
- **Page boosting**: WebPage types get a +15 score boost; VideoObject types are demoted (0.7x) so transcripts don't dominate results
- **Conversation context**: pass previous exchanges via the `prev` parameter for multi-turn conversations (up to 3 prior turns)
- **Prompt caching**: uses Cloudflare's `x-session-affinity` header so follow-up queries in the same session reuse cached prompt state
- **NLWeb protocol**: compatible with AI agents that speak NLWeb
- **Zero infrastructure**: no database, no vector store — everything runs on Cloudflare's free/cheap tiers

## How it works

1. **Build time**: a script scans your markdown content, builds a search index, and generates embeddings via Workers AI. Embeddings are cached by content hash — only changed documents are re-embedded.

2. **Runtime**: a Cloudflare Pages Function receives queries at `/ask`, runs hybrid keyword + cosine similarity search against the in-memory index, and optionally generates an LLM answer using the top results as context.

## Setup

### 1. Install

```bash
npm install nlweb-cloudflare
```

Or copy the files directly into your project.

### 2. Configure

Copy `nlweb.config.mjs` to your project root and update it:

```js
export default {
  site: 'yoursite.com',
  siteUrl: 'https://yoursite.com',
  siteDescription: 'A blog by You about your topics.',
  contentDirs: [
    { dir: 'src/content/blog', type: 'BlogPosting', baseUrl: '/' },
  ],
  outputDir: 'src/generated',
  indexFile: 'nlweb-index',
  indexImport: '../src/generated/nlweb-index.mjs',
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  chatModel: '@cf/meta/llama-3.1-70b-instruct',
  maxContextChars: 10000,
  maxEmbedChars: 2000,
  maxTokens: 512,
  temperature: 0.3,
};
```

### 3. Generate the index

```bash
CF_ACCOUNT_ID=your-account-id CF_API_TOKEN=your-api-token npx nlweb-cloudflare
```

Or add it to your build scripts:

```json
{
  "scripts": {
    "prebuild": "CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node node_modules/nlweb-cloudflare/generate-index.mjs"
  }
}
```

The embeddings are optional — if you don't set the Cloudflare credentials, the index is generated without embeddings and search falls back to keyword-only.

### 4. Add the Cloudflare Function

Copy `ask.js` to your `functions/` directory and update the import path and site config at the top of the file:

```js
import nlwebIndex from '../src/generated/nlweb-index.mjs';

const SITE_NAME = 'yoursite.com';
const SITE_URL = 'https://yoursite.com';
const SITE_DESCRIPTION = 'A blog by You about your topics.';
```

### 5. Add the Workers AI binding

In your Cloudflare Pages project settings:

1. Go to **Settings** → **Functions** → **Bindings**
2. Add a **Workers AI** binding with variable name `AI`

This enables semantic search at query time and LLM answer generation.

## API

### `GET /ask?q=your+question`

Parameters:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` / `query` | yes | Natural language query |
| `mode` | no | `list` (default), `summarize`, or `generate` |
| `site` | no | Site identifier (default: your configured site) |
| `prev` | no | JSON array of `{query, answer}` objects for conversation context |
| `decontextualized_query` | no | Pre-processed query (bypasses the raw query) |
| `query_id` | no | Request tracking ID (auto-generated if omitted) |

### Response

```json
{
  "query_id": "uuid",
  "site": "yoursite.com",
  "mode": "generate",
  "query": "your question",
  "results": [
    {
      "url": "/post-slug/",
      "name": "Post Title",
      "site": "yoursite.com",
      "score": 42,
      "description": "Post excerpt...",
      "schema_object": { ... }
    }
  ],
  "answer": "The answer with [inline links](https://yoursite.com/post/)...",
  "sources": [
    { "url": "https://yoursite.com/post/", "title": "Post Title" }
  ]
}
```

### Modes

- **`list`**: returns search results only (no AI, fast)
- **`summarize`**: returns results + AI-generated summary
- **`generate`**: returns results + AI-generated answer with inline links (recommended)

## Content format

The index generator expects markdown files with frontmatter:

```yaml
---
title: "Post Title"
publishDate: 2024-01-15  # or `date:`
excerpt: "Optional excerpt"
categories:               # or `tags:`
  - Category
draft: true               # drafts are excluded
---
```

It scans directories recursively, handling both single-file posts (`post.md`) and directory-based posts (`post/index.md`).

## Costs

- **Embeddings** (build time): ~100 posts = free tier. Cached, so subsequent builds cost nothing for unchanged content.
- **Query embedding** (runtime): 1 embedding call per question. Negligible.
- **LLM answer** (runtime): 1 Llama 3.1 70B call per `generate`/`summarize` request. Free tier covers light usage.

## License

MIT
