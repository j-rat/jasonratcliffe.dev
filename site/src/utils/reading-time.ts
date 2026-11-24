// Estimated reading time for a Markdown post: prose words only, at an average adult reading speed.
// Code blocks, raw HTML (widgets, figures) and long unbroken strings such as example tokens are skipped.
const WORDS_PER_MINUTE = 220;

export function readingMinutes(markdown: string | undefined): number {
  const prose = (markdown ?? '')
    .replace(/^---[\s\S]*?^---/m, ' ') // front matter
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/<[^>]+>/g, ' ') // HTML tags (their text content still counts)
    .replace(/\S{40,}/g, ' ') // tokens, keys, hashes
    .replace(/[#>*_`|[\]()-]/g, ' ');
  const words = prose.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
