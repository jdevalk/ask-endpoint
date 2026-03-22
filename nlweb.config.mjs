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
  // Each entry: { dir, type (schema.org type), baseUrl (URL prefix) }
  contentDirs: [
    { dir: 'src/content/blog', type: 'BlogPosting', baseUrl: '/' },
    { dir: 'src/content/pages', type: 'WebPage', baseUrl: '/' },
  ],

  // Output paths (relative to project root)
  outputDir: 'src/generated',
  indexFile: 'nlweb-index',          // produces .json and .mjs

  // Path to the index module, as imported by the Cloudflare Function
  // This is relative to where your function file lives
  indexImport: '../src/generated/nlweb-index.mjs',

  // Cloudflare Workers AI models
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  chatModel: '@cf/meta/llama-3.1-70b-instruct',

  // Generation settings
  maxContextChars: 10000,    // Max chars of content sent as LLM context
  maxEmbedChars: 2000,       // Max chars per document for embedding input
  maxTokens: 512,            // Max tokens in LLM response
  temperature: 0.3,          // LLM temperature (lower = more focused)
};
