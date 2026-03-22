/**
 * NLWeb /ask endpoint — Cloudflare Pages Function
 *
 * Drop this file into your `functions/` directory (e.g. `functions/ask.js`).
 * Requires a Workers AI binding named `AI` in your Cloudflare Pages project.
 *
 * Update the import path and config values below to match your project.
 */

// UPDATE THIS: path to your generated index module, relative to this file
import nlwebIndex from '../src/generated/nlweb-index.mjs';

// UPDATE THESE: your site details
const SITE_NAME = 'example.com';
const SITE_URL = 'https://example.com';
const SITE_DESCRIPTION = 'A blog by Example Author about various topics.';

// Models
const CHAT_MODEL = '@cf/meta/llama-3.1-70b-instruct';
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

// Generation settings
const MAX_CONTEXT_CHARS = 10000;
const MAX_TOKENS = 512;
const TEMPERATURE = 0.3;

// ============================================================
// System prompt — customize for your site
// ============================================================

const SYSTEM_PROMPT = `You are a helpful assistant answering questions about ${SITE_DESCRIPTION}

Rules:
- Answer ONLY based on the provided context. Do not make up information.
- If the context doesn't contain enough information to answer, say so honestly.
- Keep answers concise and direct — 2-4 sentences for simple questions, more for complex ones.
- ALWAYS link to the posts you reference using markdown: [Post Title](URL). The URL is provided in the context for each post. Every answer should include at least one link.
- Do not repeat the question back. Just answer it.
- Write in a natural, conversational tone.
- Use markdown formatting: **bold** for emphasis, bullet lists where appropriate, and links for referenced posts.
- Each post has a publication date. When posts contain conflicting or evolving views, prefer the most recent post. You can acknowledge the evolution if relevant.`;

// ============================================================
// Internals — no need to modify below this line
// ============================================================

const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
	'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who',
	'why', 'with', 'you', 'your'
]);

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Content-Type': 'application/json; charset=utf-8',
};

function json(body, status = 200) {
	return new Response(JSON.stringify(body, null, 2), { status, headers: CORS_HEADERS });
}

function tokenize(value = '') {
	return String(value)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

function buildNeedle(doc) {
	return [doc.name, doc.description, doc.type, ...(doc.keywords || []), doc.text].join(' \n ').toLowerCase();
}

function scoreDocument(doc, tokens, fullQuery) {
	const needle = buildNeedle(doc);
	let score = 0;
	if (fullQuery && needle.includes(fullQuery.toLowerCase())) score += 20;
	for (const token of tokens) {
		const occ = needle.split(token).length - 1;
		if (!occ) continue;
		score += occ;
		if (doc.name.toLowerCase().includes(token)) score += 8;
		if (doc.description.toLowerCase().includes(token)) score += 4;
		if ((doc.keywords || []).some((k) => String(k).toLowerCase().includes(token))) score += 6;
		if (doc.url.toLowerCase().includes(token)) score += 3;
	}

	// Pages are authoritative/canonical — boost them over blog posts and videos
	if (score > 0 && doc.type === 'WebPage') score += 15;

	// Videos (transcript-heavy) are less useful as sources — demote slightly
	if (score > 0 && doc.type === 'VideoObject') score = Math.round(score * 0.7);

	return score;
}

function cosineSimilarity(a, b) {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0, magA = 0, magB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		magA += a[i] * a[i];
		magB += b[i] * b[i];
	}
	const mag = Math.sqrt(magA) * Math.sqrt(magB);
	return mag === 0 ? 0 : dot / mag;
}

async function embedQuery(ai, query) {
	if (!ai) return null;
	try {
		const res = await ai.run(EMBEDDING_MODEL, { text: [query] });
		return res?.data?.[0] || null;
	} catch {
		return null;
	}
}

function search(query, queryEmbedding) {
	const tokens = tokenize(query);
	return nlwebIndex
		.map((doc) => {
			const keywordScore = scoreDocument(doc, tokens, query);
			let semanticScore = 0;
			if (queryEmbedding && doc.embedding) {
				semanticScore = Math.max(0, cosineSimilarity(queryEmbedding, doc.embedding) - 0.3) * 100;
			}
			return { document: doc, score: keywordScore + semanticScore, keywordScore, semanticScore };
		})
		.filter((item) => item.score > 2)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8);
}

function buildContext(scoredResults) {
	// Sort pages first within the results so the LLM sees canonical info before blog posts
	const sorted = [...scoredResults].sort((a, b) => {
		const aPage = a.document.type === 'WebPage' ? 1 : 0;
		const bPage = b.document.type === 'WebPage' ? 1 : 0;
		return bPage - aPage || b.score - a.score;
	});

	const maxResults = Math.min(sorted.length, 5);
	const perResultBudget = Math.floor(MAX_CONTEXT_CHARS / maxResults);
	let context = '';
	const sources = [];
	for (let i = 0; i < maxResults; i++) {
		const { document: doc } = sorted[i];
		const text = doc.text.length > perResultBudget ? doc.text.slice(0, perResultBudget) + '...' : doc.text;
		const date = doc.datePublished ? `Published: ${doc.datePublished.split('T')[0]}\n` : '';
		context += `## ${doc.name}\nURL: ${SITE_URL}${doc.url}\n${date}${text}\n\n`;
		sources.push({ url: `${SITE_URL}${doc.url}`, title: doc.name });
	}
	return { context, sources };
}

function fallbackSummarize(query, results) {
	if (!results.length) {
		return { answer: `I couldn't find a good match on ${SITE_NAME} for "${query}". Try a more specific query.`, sources: [] };
	}
	const top = results[0];
	const extras = results.slice(1, 3).map((r) => r.name);
	const extraText = extras.length ? ` Related matches include ${extras.join(' and ')}.` : '';
	return {
		answer: `${top.name} looks like the best match for "${query}". ${top.description}${extraText}`,
		sources: results.slice(0, 3).map((r) => ({ url: `${SITE_URL}${r.url}`, title: r.name })),
	};
}

async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
	const { context, sources } = buildContext(scoredResults);
	if (!context.trim()) return fallbackSummarize(query, scoredResults.map((r) => r.document));

	try {
		const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
		if (prevExchanges?.length > 0) {
			for (const ex of prevExchanges.slice(-3)) {
				messages.push({ role: 'user', content: ex.query });
				messages.push({ role: 'assistant', content: ex.answer });
			}
		}
		messages.push({ role: 'user', content: `Context from ${SITE_NAME}:\n\n${context}\n\nQuestion: ${query}` });

		const response = await ai.run(CHAT_MODEL, {
			messages, max_tokens: MAX_TOKENS, temperature: TEMPERATURE,
		}, {
			headers: { 'x-session-affinity': sessionId },
		});
		const answer = response.response || response.result?.response;
		if (!answer) throw new Error('Empty model response');

		// Extract sources the model actually referenced
		const usedUrls = new Set();
		let match;
		const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
		while ((match = linkRe.exec(answer)) !== null) usedUrls.add(match[2].replace(/\/$/, ''));
		let usedSources = sources.filter((s) => usedUrls.has(s.url.replace(/\/$/, '')));
		if (usedSources.length === 0) usedSources = sources;

		return { answer, sources: usedSources };
	} catch (err) {
		console.error('AI generation failed, falling back:', err.message);
		return fallbackSummarize(query, scoredResults.map((r) => r.document));
	}
}

async function normalizeRequest(request) {
	const url = new URL(request.url);
	const qs = url.searchParams;
	let body = {};
	if (request.method !== 'GET' && request.headers.get('content-type')?.includes('application/json')) {
		body = await request.json();
	}
	return {
		query: body.query || body.q || qs.get('query') || qs.get('q') || '',
		mode: body.mode || qs.get('mode') || 'list',
		site: body.site || qs.get('site') || SITE_NAME,
		prev: body.prev || qs.get('prev') || '',
		decontextualized_query: body.decontextualized_query || qs.get('decontextualized_query') || '',
		query_id: body.query_id || qs.get('query_id') || crypto.randomUUID(),
	};
}

async function handle(request, env) {
	const payload = await normalizeRequest(request);
	const query = payload.decontextualized_query || payload.query;

	if (!query.trim()) {
		return json({ error: 'Missing required query parameter: query', query_id: payload.query_id }, 400);
	}

	const ai = env?.AI;
	const queryEmbedding = ai ? await embedQuery(ai, query) : null;
	const scoredResults = search(query, queryEmbedding);

	const results = scoredResults.map(({ document: doc, score }) => ({
		url: doc.url, name: doc.name, site: payload.site, score,
		description: doc.description, schema_object: doc.schema_object,
	}));

	const response = { query_id: payload.query_id, site: payload.site, mode: payload.mode, query, results };

	if (payload.mode === 'summarize' || payload.mode === 'generate') {
		let prevExchanges = [];
		if (payload.prev) { try { prevExchanges = JSON.parse(payload.prev); } catch {} }

		const generated = ai
			? await generateAnswer(ai, query, scoredResults, prevExchanges, payload.query_id)
			: fallbackSummarize(query, scoredResults.map((r) => r.document));

		response.answer = generated.answer;
		response.summary = generated.answer;
		response.sources = generated.sources;
	}

	return json(response);
}

// ============================================================
// Cloudflare Pages Function exports
// ============================================================

export function onRequestOptions() {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
	return handle(context.request, context.env);
}

export async function onRequestPost(context) {
	return handle(context.request, context.env);
}
