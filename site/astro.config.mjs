// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jasonratcliffe.dev',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    // Keep every script and stylesheet external so the CSP can forbid inline code.
    inlineStylesheets: 'never',
  },
  markdown: {
    // Prism emits classes; Shiki emits inline style attributes the CSP would block.
    syntaxHighlight: 'prism',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
