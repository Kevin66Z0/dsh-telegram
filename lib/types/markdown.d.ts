/**
 * Markdown → Telegram HTML projection for assistant replies. The model's
 * GFM markdown is parsed into an mdast tree and serialized to Telegram's
 * HTML subset: Telegram has no headings, lists, or tables, so those map to
 * bold lines, bullet/number lines, and flattened rows. Raw HTML stays
 * literal text, and link destinations pass an http(s) allowlist.
 * @module @deepseek-ai/dsh-host-telegram/markdown
 */
/**
 * Project GFM markdown to Telegram HTML.
 * @param markdown - the assistant-authored markdown source.
 * @returns Telegram-HTML text, or an empty string for blank input.
 */
export declare function markdownToTelegramHtml(markdown: string): string;
//# sourceMappingURL=markdown.d.ts.map