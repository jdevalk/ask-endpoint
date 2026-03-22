#!/usr/bin/env node

/**
 * NLWeb Index Generator
 *
 * Scans markdown content directories, builds a searchable index with
 * embeddings via Cloudflare Workers AI, and outputs JSON + ESM files.
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node generate-index.mjs
 *
 * Embeddings are cached by content hash — only changed documents are re-embedded.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';

// Load config
const rootDir = process.cwd();
let config;
try {
  config = (await import(path.join(rootDir, 'nlweb.config.mjs'))).default;
} catch {
  console.error('Missing nlweb.config.mjs in project root. Copy the template from nlweb-cloudflare.');
  process.exit(1);
}

const outputDir = path.join(rootDir, config.outputDir);
const outputJsonPath = path.join(outputDir, `${config.indexFile}.json`);
const outputModulePath = path.join(outputDir, `${config.indexFile}.mjs`);
const embeddingCachePath = path.join(outputDir, 'embedding-cache.json');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const EMBEDDING_MODEL = config.embeddingModel;
const MAX_EMBED_CHARS = config.maxEmbedChars;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

// ============================================================
// Markdown utilities
// ============================================================

function stripMarkdown(value = '') {
  return String(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 1) return value[1];
  return String(value);
}

// ============================================================
// File scanner
// ============================================================

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (MARKDOWN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildUrl(contentType, filePath, frontmatter) {
  const contentDir = path.resolve(rootDir, contentType.dir);
  const relative = path.relative(contentDir, filePath);
  const parsed = path.parse(relative);

  if (frontmatter.slug) {
    const slug = frontmatter.slug;
    return slug.startsWith('/') ? slug : `/${slug}/`;
  }

  const slug = parsed.dir && parsed.name === 'index'
    ? path.basename(parsed.dir)
    : parsed.name;

  if (slug === 'index' || slug === 'home') return '/';
  return `${contentType.baseUrl}${slug}/`;
}

function buildRecord(contentType, filePath, parsedFile) {
  const data = parsedFile.data || {};
  const title = data.title || path.basename(path.dirname(filePath)) || path.parse(filePath).name;
  const url = buildUrl(contentType, filePath, data);
  const bodyText = stripMarkdown(parsedFile.content);
  const excerpt = stripMarkdown(data.excerpt || bodyText.slice(0, 280));
  const keywords = Array.isArray(data.categories)
    ? data.categories.map((v) => Array.isArray(v) ? v[0] : String(v))
    : Array.isArray(data.tags)
      ? data.tags.map(String)
      : [];

  return {
    id: `${path.relative(rootDir, filePath)}`,
    url,
    site: config.site,
    name: title,
    type: contentType.type,
    description: excerpt,
    datePublished: normalizeDate(data.publishDate || data.date),
    keywords,
    text: bodyText,
    schema_object: {
      '@context': 'https://schema.org',
      '@type': contentType.type,
      headline: title,
      url,
      description: excerpt,
      datePublished: normalizeDate(data.publishDate || data.date),
      keywords,
    },
  };
}

// ============================================================
// Embedding generation with cache
// ============================================================

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function embeddingInput(record) {
  return [record.name, record.description, record.keywords.join(', '), record.text.slice(0, MAX_EMBED_CHARS)].join('\n');
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(embeddingCachePath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(embeddingCachePath, JSON.stringify(cache), 'utf8');
}

async function fetchEmbeddings(texts) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    }
  );
  const data = await res.json();
  if (!data.success || !data.result?.data) {
    throw new Error(`Embedding API error: ${JSON.stringify(data.errors)}`);
  }
  return data.result.data;
}

async function generateEmbeddings(records) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.log('  Skipping embeddings (CF_ACCOUNT_ID and CF_API_TOKEN not set)');
    return records.map(() => null);
  }

  const cache = await loadCache();
  const toEmbed = [];
  const embeddings = new Array(records.length);

  for (let i = 0; i < records.length; i++) {
    const text = embeddingInput(records[i]);
    const hash = contentHash(text);
    if (cache[records[i].id]?.hash === hash) {
      embeddings[i] = cache[records[i].id].embedding;
    } else {
      toEmbed.push({ index: i, text, hash, id: records[i].id });
    }
  }

  const cached = records.length - toEmbed.length;
  if (cached > 0) console.log(`  Embedding cache: ${cached} cached, ${toEmbed.length} to generate`);

  const BATCH_SIZE = 20;
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    console.log(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)} (${batch.length} items)...`);
    const vectors = await fetchEmbeddings(batch.map((b) => b.text));
    for (let j = 0; j < batch.length; j++) {
      embeddings[batch[j].index] = vectors[j];
      cache[batch[j].id] = { hash: batch[j].hash, embedding: vectors[j] };
    }
    if (i + BATCH_SIZE < toEmbed.length) await new Promise((r) => setTimeout(r, 200));
  }

  await saveCache(cache);
  return embeddings;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const records = [];

  for (const contentType of config.contentDirs) {
    const dir = path.resolve(rootDir, contentType.dir);
    const files = await walk(dir);
    for (const filePath of files) {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsedFile = matter(raw);
      // Skip drafts
      if (parsedFile.data.draft) continue;
      records.push(buildRecord(contentType, filePath, parsedFile));
    }
  }

  records.sort((a, b) => (b.datePublished || '').localeCompare(a.datePublished || ''));

  console.log(`Generating index for ${records.length} records...`);
  const embeddings = await generateEmbeddings(records);
  for (let i = 0; i < records.length; i++) {
    records[i].embedding = embeddings[i];
  }

  await fs.mkdir(outputDir, { recursive: true });
  const json = JSON.stringify(records, null, 2) + '\n';
  await fs.writeFile(outputJsonPath, json, 'utf8');
  await fs.writeFile(outputModulePath, `export default ${json};`, 'utf8');

  const sizeKB = Math.round(Buffer.byteLength(json) / 1024);
  console.log(`Generated NLWeb index: ${records.length} records (${sizeKB}KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
