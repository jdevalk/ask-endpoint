import siteConfig from '../../nlweb.config.mjs';

export const MAX_CONTEXT_CHARS = siteConfig.maxContextChars || 10000;
export const MAX_QUERY_LENGTH = siteConfig.maxQueryLength || 500;
export const AI_TIMEOUT_MS = siteConfig.aiTimeoutMs || 10000;
export const MODEL = siteConfig.chatModel || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const EMBEDDING_MODEL = siteConfig.embeddingModel || '@cf/baai/bge-base-en-v1.5';
export const MAX_TOKENS = siteConfig.maxTokens || 512;
export const TEMPERATURE = siteConfig.temperature || 0.3;

export const TYPE_LABELS = siteConfig.typeLabels || {
	'WebPage': 'page',
	'BlogPosting': 'blog post',
	'VideoObject': 'video',
};

export function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('AI request timed out')), ms);
		promise.then(
			(val) => { clearTimeout(timer); resolve(val); },
			(err) => { clearTimeout(timer); reject(err); },
		);
	});
}
