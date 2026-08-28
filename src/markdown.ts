/**
 * Markdown → Telegram HTML projection for assistant replies. The model's
 * GFM markdown is parsed into an mdast tree and serialized to Telegram's
 * HTML subset: Telegram has no headings, lists, or tables, so those map to
 * bold lines, bullet/number lines, and flattened rows. Raw HTML stays
 * literal text, and link destinations pass an http(s) allowlist.
 * @module @deepseek-ai/dsh-host-telegram/markdown
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type * as Md from 'mdast'
import { escapeHtml } from './render.ts'

/** Telegram <a> supports only absolute HTTP(S) destinations; anything else stays inert text. */
const SAFE_LINK_SCHEME = /^https?:\/\//i

/** The divider a thematic break renders as. */
const THEMATIC_BREAK = '────────'

/** Reference definitions resolved from the document, keyed by normalized identifier. */
type Definitions = ReadonlyMap<string, string>

/**
 * Escape one link destination for an HTML attribute value.
 * @param url - the destination URL.
 * @returns the entity-escaped URL.
 */
function escapeHref(url: string): string {
  return url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Project GFM markdown to Telegram HTML.
 * @param markdown - the assistant-authored markdown source.
 * @returns Telegram-HTML text, or an empty string for blank input.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const definitions = collectDefinitions(root)
  return root.children.map(node => blockToHtml(node, definitions)).filter(text => text !== '').join('\n\n')
}

/** Collect reference-style link/image destinations into a lookup map. */
function collectDefinitions(root: Md.Root): Definitions {
  const map = new Map<string, string>()
  for (const node of root.children) {
    if (node.type === 'definition') map.set(node.identifier.toLowerCase(), node.url)
  }
  return map
}

/** Serialize one root-level block node. */
function blockToHtml(node: Md.RootContent, definitions: Definitions): string {
  switch (node.type) {
    case 'paragraph':
      return inlineToHtml(node.children, definitions)
    case 'heading':
      return '<b>' + inlineToHtml(node.children, definitions) + '</b>'
    case 'thematicBreak':
      return THEMATIC_BREAK
    case 'blockquote':
      return '<blockquote>' + node.children.map(child => blockToHtml(child, definitions)).filter(text => text !== '').join('\n') + '</blockquote>'
    case 'list':
      return listToHtml(node, definitions, 0)
    case 'code':
      return codeBlockToHtml(node.value, node.lang)
    case 'table':
      return tableToHtml(node, definitions)
    case 'html':
      return escapeHtml(node.value)
    case 'definition':
    case 'footnoteDefinition':
      return ''
    /* v8 ignore next 2 -- merge-extensible block union: unknown node types render nothing. */
    default:
      return ''
  }
}

/** Serialize a run of inline (phrasing) nodes. */
function inlineToHtml(nodes: readonly Md.PhrasingContent[], definitions: Definitions): string {
  let out = ''
  for (const node of nodes) out += phrasingToHtml(node, definitions)
  return out
}

/** Serialize one inline node. */
function phrasingToHtml(node: Md.PhrasingContent, definitions: Definitions): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value)
    case 'break':
      return '\n'
    case 'strong':
      return '<b>' + inlineToHtml(node.children, definitions) + '</b>'
    case 'emphasis':
      return '<i>' + inlineToHtml(node.children, definitions) + '</i>'
    case 'delete':
      return '<s>' + inlineToHtml(node.children, definitions) + '</s>'
    case 'inlineCode':
      return '<code>' + escapeHtml(node.value.replace(/\r?\n|\r/g, ' ')) + '</code>'
    case 'link':
      return linkToHtml(node.url, inlineToHtml(node.children, definitions))
    case 'linkReference':
      return linkToHtml(resolveDefinition(definitions, node.identifier), inlineToHtml(node.children, definitions))
    case 'image':
      return escapeHtml(imageAlt(node.alt, node.url))
    case 'imageReference':
      return escapeHtml(imageAlt(node.alt, resolveDefinition(definitions, node.identifier)))
    case 'html':
      return escapeHtml(node.value)
    case 'footnoteReference':
      return escapeHtml('[^' + node.identifier + ']')
    /* v8 ignore next 2 -- merge-extensible phrasing union: unknown node types render nothing. */
    default:
      return ''
  }
}

/** Resolve a reference-style destination; absent only for a hand-built tree. */
function resolveDefinition(definitions: Definitions, identifier: string): string {
  /* v8 ignore next -- fromMarkdown keeps unresolvable references as literal text, so parsed references always resolve. */
  return definitions.get(identifier.toLowerCase()) ?? ''
}

/** Wrap one link when its destination is an absolute HTTP(S) URL. */
function linkToHtml(url: string, text: string): string {
  if (text === '' || !SAFE_LINK_SCHEME.test(url)) return text
  return '<a href="' + escapeHref(url) + '">' + text + '</a>'
}

/** The alt text an image falls back to when absent. */
function imageAlt(alt: string | null | undefined, url: string): string {
  /* v8 ignore next -- fromMarkdown emits a (possibly empty) string alt; the null/undefined arms only satisfy the mdast union. */
  return alt === null || alt === undefined || alt === '' ? url : alt
}

/** One fenced code block, with a language class when one is present. */
function codeBlockToHtml(value: string, lang: string | null | undefined): string {
  const escaped = escapeHtml(value)
  const language = /^[\w-]+/.exec(lang ?? '')?.[0]
  return language === undefined ? '<pre>' + escaped + '</pre>' : '<pre><code class="language-' + language + '">' + escaped + '</code></pre>'
}

/** One GFM table flattened to cell | cell lines with a bold header row. */
function tableToHtml(table: Md.Table, definitions: Definitions): string {
  return table.children.map((row, index) => {
    const line = row.children.map(cell => inlineToHtml(cell.children, definitions)).join(' | ')
    return index === 0 ? '<b>' + line + '</b>' : line
  }).join('\n')
}

/** One list flattened to marker-prefixed lines with two-space nesting. */
function listToHtml(list: Md.List, definitions: Definitions, depth: number): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let number = list.start ?? 1
  for (const item of list.children) {
    const marker = typeof item.checked === 'boolean' ? (item.checked ? '☑' : '☐') : (list.ordered === true ? String(number) + '.' : '•')
    const paragraphs: string[] = []
    for (const child of item.children) {
      if (child.type === 'list') continue
      paragraphs.push(blockToHtml(child, definitions))
    }
    const first = paragraphs[0]
    lines.push(first === undefined ? indent + marker : indent + marker + ' ' + first)
    for (let i = 1; i < paragraphs.length; i++) lines.push(indent + '  ' + paragraphs[i])
    for (const child of item.children) {
      if (child.type === 'list') lines.push(listToHtml(child, definitions, depth + 1))
    }
    number++
  }
  return lines.join('\n')
}
