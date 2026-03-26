# ask-endpoint

An AI-powered `/ask` endpoint for static sites on Cloudflare Pages. Adds Q&A to any markdown-based site using Cloudflare Workers AI. Compatible with the [NLWeb](https://github.com/nlweb-ai/NLWeb) protocol.

## What it does

- **Hybrid search**: keyword scoring (with log-scaled occurrence capping) + semantic embeddings
- **LLM answers**: generates natural language answers grounded in your content, with streaming support
- **Source filtering**: extracts sources the LLM actually referenced (by URL and title matching), with fallback
- **Search weighting**: per-document `searchWeight` via frontmatter or content type defaults — no hardcoded type boosts
- **Conversation context**: multi-turn follow-ups via the `prev` parameter, with automatic query augmentation for vague follow-ups
- **Prompt caching**: uses Cloudflare's `x-session-affinity` header so follow-up queries reuse cached prompt state
- **Debug mode**: append `?debug=true` to see timing, retrieval scores, index size, and model info
- **NLWeb protocol**: compatible with AI agents that speak NLWeb
- **Zero infrastructure**: no database, no vector store — everything runs on Cloudflare's free/cheap tiers

## File structure

```
functions/
  ask.js                 # Entry point (Cloudflare Pages Function)
  _ask/
    config.js            # Constants, model config, helpers
    retrieval.js         # Search, scoring, embedding, query augmentation
    generation.js        # LLM prompting, context building, source extraction
nlweb.config.mjs         # Site configuration (edit this)
generate-index.mjs       # Build-time index generator
```

## Setup

### 1. Install

Clone the repo or copy the files directly into your project.

### 2. Configure

Copy `nlweb.config.mjs` to your project root and update it:

```js
export default {
  site: 'yoursite.com',
  siteUrl: 'https://yoursite.com',
  siteDescription: 'A blog by You about your topics.',
  contentDirs: [
    { dir: 'src/content/blog', type: 'BlogPosting', baseUrl: '/', defaultSearchWeight: 1.0 },
    { dir: 'src/content/pages', type: 'WebPage', baseUrl: '/', defaultSearchWeight: 1.2 },
  ],
  outputDir: 'src/generated',
  indexFile: 'nlweb-index',
  indexImport: '../src/generated/nlweb-index.mjs',
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  chatModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  maxContextChars: 10000,
  maxEmbedChars: 2000,
  maxTokens: 512,
  temperature: 0.3,
  maxQueryLength: 500,
  aiTimeoutMs: 10000,
  queryAliases: [],
  typeLabels: {
    'WebPage': 'page',
    'BlogPosting': 'blog post',
    'VideoObject': 'video',
  },
};
```

### 3. Generate the index

```bash
CF_ACCOUNT_ID=your-account-id CF_API_TOKEN=your-api-token node generate-index.mjs
```

Or add it to your build scripts:

```json
{
  "scripts": {
    "prebuild": "CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node generate-index.mjs"
  }
}
```

The embeddings are optional -- if you don't set the Cloudflare credentials, the index is generated without embeddings and search falls back to keyword-only.

### 4. Add the Cloudflare Function

Copy the entire `functions/` directory (including `_ask/`) into your project root. The import path in `functions/ask.js` expects `nlweb.config.mjs` and the generated index at the paths configured above.

### 5. Add the Workers AI binding

In your Cloudflare Pages project settings:

1. Go to **Settings** -> **Functions** -> **Bindings**
2. Add a **Workers AI** binding with variable name `AI`

## API

### `GET /ask?q=your+question`

Parameters:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` / `query` | yes | Natural language query (max 500 chars) |
| `mode` | no | `list` (default), `summarize`, `generate`, or `stream` |
| `site` | no | Site identifier (default: your configured site) |
| `prev` | no | JSON array of `{query, answer}` objects for conversation context |
| `decontextualized_query` | no | Pre-processed query (bypasses the raw query) |
| `query_id` | no | Request tracking ID (auto-generated if omitted) |
| `debug` | no | Set to `true` for timing and retrieval diagnostics |

### Response (JSON modes)

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
      "schema_object": { }
    }
  ],
  "answer": "The answer with [inline links](https://yoursite.com/post/)...",
  "sources": [
    { "url": "https://yoursite.com/post/", "title": "Post Title" }
  ]
}
```

### Streaming mode (`mode=stream`)

Returns a `text/event-stream` with Server-Sent Events:

```
data: {"token": "The "}
data: {"token": "answer "}
data: {"token": "is..."}
data: {"sources": [...], "done": true}
```

On error or timeout, the final event includes an `error` field. If the streamed answer is too short/empty, a `fallback` answer is sent instead.

### Modes

- **`list`**: returns search results only (no AI, fast)
- **`summarize`**: returns results + AI-generated summary
- **`generate`**: returns results + AI-generated answer with inline links
- **`stream`**: returns results via SSE with real-time token streaming (recommended for interactive UIs)

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
searchWeight: 1.5         # optional, overrides the content type default
---
```

### Search weighting

Each document gets a `searchWeight` multiplier applied to its blended (keyword + semantic) score. This replaces hardcoded type-based boosts with a flexible per-document system.

- Set `defaultSearchWeight` on each content type in config (e.g., 1.2 for pages, 0.5 for video transcripts)
- Override per-document with `searchWeight` in frontmatter
- Default is `1.0` if neither is set

### Query aliases

Expand domain-specific abbreviations in search queries by adding regex patterns to `queryAliases` in config:

```js
queryAliases: [
  ['\\bwp\\b', 'wordpress'],
  ['\\bcms share\\b', 'cms market share'],
],
```

Each entry is `[regexPattern, replacement]`. Patterns are applied with case-insensitive global flags.

## Costs

- **Embeddings** (build time): ~100 posts = free tier. Cached, so subsequent builds cost nothing for unchanged content.
- **Query embedding** (runtime): 1 embedding call per question. Negligible.
- **LLM answer** (runtime): 1 Llama 3.3 70B call per `generate`/`summarize`/`stream` request. Free tier covers light usage.

## License

MIT
