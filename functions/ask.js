/**
 * NLWeb /ask endpoint — Cloudflare Pages Function
 *
 * Drop the `functions/` directory (with `_ask/`) into your project.
 * Requires a Workers AI binding named `AI` in your Cloudflare Pages project.
 */

import config from '../nlweb.config.mjs';
import nlwebIndex from '../src/generated/nlweb-index.mjs';
import { MAX_QUERY_LENGTH, AI_TIMEOUT_MS, MODEL } from './_ask/config.js';
import { search, embedQuery, augmentQuery } from './_ask/retrieval.js';
import {
	generateStreamingAnswer, generateAnswer,
	fallbackSummarize, extractSources,
} from './_ask/generation.js';

const headers = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Content-Type': 'application/json; charset=utf-8',
};

function json(body, status = 200) {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers,
	});
}

async function normalizeRequest(request) {
	const url = new URL(request.url);
	const query = url.searchParams;
	let body = {};

	if (request.method !== 'GET' && request.headers.get('content-type')?.includes('application/json')) {
		try {
			body = await request.json();
		} catch {
			throw new Error('Invalid JSON body');
		}
	}

	return {
		query: String(body.query || body.q || query.get('query') || query.get('q') || '').slice(0, MAX_QUERY_LENGTH),
		mode: body.mode || query.get('mode') || 'list',
		site: body.site || query.get('site') || config.site,
		prev: String(body.prev || query.get('prev') || '').slice(0, 10000),
		decontextualized_query: String(body.decontextualized_query || query.get('decontextualized_query') || '').slice(0, MAX_QUERY_LENGTH),
		query_id: body.query_id || query.get('query_id') || crypto.randomUUID(),
		debug: body.debug || query.get('debug') === 'true',
	};
}

function handleStreamingResponse(stream, sources, query, scoredResults, writer, encoder) {
	(async () => {
		let fullAnswer = '';
		const streamTimeout = setTimeout(async () => {
			try {
				const msg = fullAnswer
					? 'Response was cut short due to a timeout.'
					: 'The AI took too long to respond. Please try again.';
				await writer.write(encoder.encode(`data: ${JSON.stringify({ error: msg, done: true })}\n\n`));
				await writer.close();
			} catch { /* already closed */ }
		}, AI_TIMEOUT_MS * 3);

		try {
			const reader = stream.getReader ? stream.getReader() : null;
			if (reader) {
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
					const lines = chunk.split('\n');
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6);
							if (data === '[DONE]') continue;
							try {
								const parsed = JSON.parse(data);
								const token = parsed.response || parsed.choices?.[0]?.delta?.content || '';
								if (token) {
									fullAnswer += token;
									await writer.write(encoder.encode(`data: ${JSON.stringify({ token })}\n\n`));
								}
							} catch {
								// Non-JSON data line, skip
							}
						}
					}
				}
			}

			clearTimeout(streamTimeout);

			// Send sources as final event (with fallback if answer was empty/garbage)
			if (fullAnswer.trim().length < 5) {
				const fallback = fallbackSummarize(query, scoredResults.map((r) => r.document));
				await writer.write(encoder.encode(`data: ${JSON.stringify({ fallback: fallback.answer, sources: fallback.sources, done: true })}\n\n`));
			} else {
				const usedSources = extractSources(fullAnswer, sources);
				await writer.write(encoder.encode(`data: ${JSON.stringify({ sources: usedSources, done: true })}\n\n`));
			}
		} catch (err) {
			clearTimeout(streamTimeout);
			await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message, done: true })}\n\n`));
		} finally {
			try { await writer.close(); } catch { /* already closed */ }
		}
	})();
}

async function handle(request, env) {
	const startTime = Date.now();

	let payload;
	try {
		payload = await normalizeRequest(request);
	} catch (err) {
		return json({ error: err.message }, 400);
	}

	const query = payload.decontextualized_query || payload.query;

	if (!query.trim()) {
		return json({
			error: 'Missing required query parameter: query',
			query_id: payload.query_id,
		}, 400);
	}

	// Guard against empty or corrupt index
	if (!Array.isArray(nlwebIndex) || nlwebIndex.length === 0) {
		return json({
			error: 'Search index is unavailable. Please try again later.',
			query_id: payload.query_id,
		}, 503);
	}

	// Parse previous exchanges early so we can use them for query augmentation
	let prevExchanges = [];
	if (payload.prev) {
		try {
			prevExchanges = JSON.parse(payload.prev);
		} catch {
			// prev can also be a comma-separated list of queries (NLWeb format) — ignore
		}
	}

	// Augment vague follow-ups with context from previous turn for better retrieval
	const searchQuery = augmentQuery(query, prevExchanges);

	// Embed query for semantic search
	const ai = env?.AI;
	const embedStart = Date.now();
	const queryEmbedding = ai ? await embedQuery(ai, searchQuery) : null;
	const embedMs = Date.now() - embedStart;

	const searchStart = Date.now();
	const scoredResults = search(searchQuery, queryEmbedding, nlwebIndex);
	const searchMs = Date.now() - searchStart;

	const results = scoredResults.map(({ document, score }) => ({
		url: document.url,
		name: document.name,
		site: payload.site,
		score,
		description: document.description,
		schema_object: document.schema_object,
	}));

	const response = {
		query_id: payload.query_id,
		site: payload.site,
		mode: payload.mode,
		query,
		results,
	};

	// Streaming mode: return SSE stream with tokens + final sources event
	if (payload.mode === 'stream' && ai) {
		try {
			const { stream, fallback, sources } = await generateStreamingAnswer(
				ai, query, scoredResults, prevExchanges, payload.query_id
			);

			// If retrieval found nothing, return fallback as a single non-streamed response
			if (!stream && fallback) {
				return json({ ...fallback, query_id: payload.query_id, mode: 'stream' });
			}

			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			const sseHeaders = {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			};

			handleStreamingResponse(stream, sources, query, scoredResults, writer, encoder);

			return new Response(readable, { headers: sseHeaders });
		} catch (err) {
			const generated = fallbackSummarize(query, scoredResults.map((r) => r.document));
			return json({ ...generated, query_id: payload.query_id, mode: 'stream', fallback: true });
		}
	}

	let generateMs = 0;
	if (payload.mode === 'summarize' || payload.mode === 'generate') {
		let generated;

		const genStart = Date.now();
		if (ai) {
			generated = await generateAnswer(ai, query, scoredResults, prevExchanges, payload.query_id);
		} else {
			generated = fallbackSummarize(query, scoredResults.map((r) => r.document));
		}
		generateMs = Date.now() - genStart;

		response.answer = generated.answer;
		response.summary = generated.answer;
		response.sources = generated.sources;
	}

	if (payload.debug) {
		response.debug = {
			timing: {
				total_ms: Date.now() - startTime,
				embed_ms: embedMs,
				search_ms: searchMs,
				generate_ms: generateMs,
			},
			retrieval: scoredResults.map(({ document, score, keywordScore, semanticScore }) => ({
				id: document.id || document.url,
				name: document.name,
				url: document.url,
				type: document.type,
				datePublished: document.datePublished,
				score,
				keywordScore,
				semanticScore,
			})),
			index_size: nlwebIndex.length,
			had_embedding: !!queryEmbedding,
			model: MODEL,
		};
	}

	return json(response);
}

export function onRequestOptions() {
	return new Response(null, { status: 204, headers });
}

export async function onRequestGet(context) {
	return handle(context.request, context.env);
}

export async function onRequestPost(context) {
	return handle(context.request, context.env);
}
