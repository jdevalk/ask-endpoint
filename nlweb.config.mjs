/**
 * NLWeb Cloudflare configuration.
 *
 * Copy this file to your project root and adjust the values.
 */
export default {
  // Your site's name and base URL
  site: 'example.com',
  siteUrl: 'https://example.com',

  // Describe your site/author for the system prompt
  siteDescription: 'A blog by Example Author about various topics.',

  // Content directories to index (relative to project root)
  // Each entry: { dir, type (schema.org type), baseUrl (URL prefix), defaultSearchWeight }
  contentDirs: [
    { dir: 'src/content/blog', type: 'BlogPosting', baseUrl: '/', defaultSearchWeight: 1.0 },
    { dir: 'src/content/pages', type: 'WebPage', baseUrl: '/', defaultSearchWeight: 1.2 },
  ],

  // Output paths (relative to project root)
  outputDir: 'src/generated',
  indexFile: 'nlweb-index',          // produces .json and .mjs

  // Path to the index module, as imported by the Cloudflare Function
  // This is relative to where your function file lives
  indexImport: '../src/generated/nlweb-index.mjs',

  // Cloudflare Workers AI models
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  chatModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',

  // Generation settings
  maxContextChars: 10000,    // Max chars of content sent as LLM context
  maxEmbedChars: 2000,       // Max chars per document for embedding input
  maxTokens: 512,            // Max tokens in LLM response
  temperature: 0.3,          // LLM temperature (lower = more focused)

  // Query and timeout settings
  maxQueryLength: 500,       // Max characters for user queries
  aiTimeoutMs: 10000,        // Timeout for AI requests in milliseconds

  // Query aliases: expand abbreviations/jargon in search queries.
  // Each entry is [regexPattern, replacement]. Patterns are applied with 'gi' flags.
  // Example: ['\\bwp\\b', 'wordpress'] expands "wp" to "wordpress"
  queryAliases: [],

  // Type labels for display in context (schema.org type -> human label)
  typeLabels: {
    'WebPage': 'page',
    'BlogPosting': 'blog post',
    'VideoObject': 'video',
  },
};
