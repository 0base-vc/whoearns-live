/**
 * Prerender the FAQ — same rationale as /glossary. FAQPage JSON-LD
 * is the entire reason this page exists for SEO; baking it into
 * static HTML means GenAI engines (Perplexity, ChatGPT browse,
 * Claude search) and Google rich-results see it on first hit.
 */
export const ssr = true;
export const prerender = true;
