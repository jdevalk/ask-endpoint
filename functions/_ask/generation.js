import { MAX_CONTEXT_CHARS, AI_TIMEOUT_MS, MODEL, MAX_TOKENS, TEMPERATURE, TYPE_LABELS, withTimeout } from './config.js';
import siteConfig from '../../nlweb.config.mjs';

const SITE_NAME = siteConfig.site || 'this site';
const SITE_URL = siteConfig.siteUrl || '';
const SITE_DESCRIPTION = siteConfig.siteDescription || 'a website';

const SYSTEM_PROMPT = `You are a helpful assistant answering questions about ${SITE_DESCRIPTION}

Rules:
- Answer ONLY based on the provided context. Do not make up information.
- If the context doesn't contain enough information to answer, say so honestly.
- Keep answers concise and direct — 2-4 sentences for simple questions, more for complex ones.
- Do not repeat the question back. Just answer it.
- Write in a natural, conversational tone.
- Use markdown formatting: **bold** for emphasis, bullet lists where appropriate, and links for referenced posts.

Attribution:
- ALWAYS link to the sources you reference using markdown: [Post Title](URL). Every answer must include at least one link.
- Only cite sources that directly support your answer. Do not link to sources just because they were provided.
- Prefer blog posts and pages over video transcripts as sources — video transcripts are rougher and less authoritative.

Temporal awareness:
- Each source has a publication date and content type. Pay attention to dates.
- When sources contain conflicting or evolving views, prefer the most recent source — views may have changed over time.
- If a question asks about a current view, base your answer on the most recent relevant source.
- When views have clearly evolved, briefly acknowledge the change (e.g., "Initially the view was X, but as of [date] it is Y").
- For factual/historical questions (e.g., "when did X happen?"), older sources are fine.

Follow-up questions:
- This may be a multi-turn conversation. Previous exchanges are included in the message history.
- When the user asks a vague follow-up (e.g., "what about that?", "tell me more", "and governance?"), interpret it in the context of the prior conversation.
- Base your answer on the NEW context provided with the follow-up question, not on the previous answer's context. The retrieval system has already searched for relevant content based on the follow-up.
- If the follow-up doesn't make sense without prior context and the new context doesn't help, ask the user to clarify.`;

export function buildContext(scoredResults) {
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
		const { document } = sorted[i];
		const text = document.text.length > perResultBudget
			? document.text.slice(0, perResultBudget) + '...'
			: document.text;
		const typeLabel = TYPE_LABELS[document.type] || 'content';
		const date = document.datePublished ? document.datePublished.split('T')[0] : null;
		const meta = [`Type: ${typeLabel}`, date ? `Published: ${date}` : null].filter(Boolean).join(' | ');
		context += `## ${document.name}\nURL: ${SITE_URL}${document.url}\n${meta}\n${text}\n\n`;
		sources.push({
			url: `${SITE_URL}${document.url}`,
			title: document.name,
			type: typeLabel,
			datePublished: date,
		});
	}

	return { context, sources };
}

export function fallbackSummarize(query, results) {
	if (!results.length) {
		return {
			answer: `I couldn't find a good match on ${SITE_NAME} for "${query}". Try a more specific query or fewer keywords.`,
			sources: [],
		};
	}

	const top = results[0];
	const extras = results.slice(1, 3).map((r) => r.name);
	const extraText = extras.length ? ` Related matches include ${extras.join(' and ')}.` : '';
	return {
		answer: `${top.name} looks like the best match for "${query}". ${top.description}${extraText}`,
		sources: results.slice(0, 3).map((r) => ({ url: `${SITE_URL}${r.url}`, title: r.name })),
	};
}

function buildMessages(query, context, prevExchanges) {
	const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

	if (prevExchanges && prevExchanges.length > 0) {
		const recent = prevExchanges.slice(-3);
		for (const exchange of recent) {
			messages.push({ role: 'user', content: exchange.query });
			const prevAnswer = exchange.answer.length > 500
				? exchange.answer.slice(0, 500) + '...'
				: exchange.answer;
			messages.push({ role: 'assistant', content: prevAnswer });
		}
	}

	messages.push({ role: 'user', content: `Context from ${SITE_NAME}:\n\n${context}\n\nQuestion: ${query}` });
	return messages;
}

export function extractSources(answer, allSources) {
	const usedUrlSet = new Set();
	const usedTitleSet = new Set();

	const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	let match;
	while ((match = linkPattern.exec(answer)) !== null) {
		usedUrlSet.add(match[2].replace(/\/$/, ''));
		usedTitleSet.add(match[1].toLowerCase());
	}

	let usedSources = allSources.filter((s) => {
		const urlNorm = s.url.replace(/\/$/, '');
		if (usedUrlSet.has(urlNorm)) return true;
		if (usedTitleSet.has(s.title.toLowerCase())) return true;
		return false;
	});

	if (usedSources.length === 0) usedSources = allSources.slice(0, 3);
	return usedSources;
}

export async function generateStreamingAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
	const { context, sources } = buildContext(scoredResults);

	if (!context.trim()) {
		const fallback = fallbackSummarize(query, scoredResults.map((r) => r.document));
		return { stream: null, fallback };
	}

	const messages = buildMessages(query, context, prevExchanges);

	const response = await withTimeout(
		ai.run(MODEL, {
			messages,
			max_tokens: MAX_TOKENS,
			temperature: TEMPERATURE,
			stream: true,
		}, {
			headers: { 'x-session-affinity': sessionId },
		}),
		AI_TIMEOUT_MS,
	);

	return { stream: response, sources };
}

export async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
	const { context, sources } = buildContext(scoredResults);

	if (!context.trim()) {
		return fallbackSummarize(query, scoredResults.map((r) => r.document));
	}

	try {
		const messages = buildMessages(query, context, prevExchanges);

		const response = await withTimeout(
			ai.run(MODEL, {
				messages,
				max_tokens: MAX_TOKENS,
				temperature: TEMPERATURE,
			}, {
				headers: { 'x-session-affinity': sessionId },
			}),
			AI_TIMEOUT_MS,
		);

		const answer = response.response
			|| response.result?.response
			|| response.choices?.[0]?.message?.content;
		if (!answer || typeof answer !== 'string' || answer.trim().length < 5) {
			throw new Error('Empty or malformed model response');
		}

		return { answer, sources: extractSources(answer, sources) };
	} catch (err) {
		console.error('AI generation failed, falling back:', err.message);
		return fallbackSummarize(query, scoredResults.map((r) => r.document));
	}
}
