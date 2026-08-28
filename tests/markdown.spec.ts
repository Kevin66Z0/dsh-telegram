import { describe, expect, it } from 'vitest'
import { markdownToTelegramHtml } from '../src/markdown.ts'

describe('markdownToTelegramHtml', () => {
  it('returns an empty string for blank input', () => {
    expect(markdownToTelegramHtml('')).toBe('')
    expect(markdownToTelegramHtml('\n\n')).toBe('')
  })

  it('escapes bare text for HTML', () => {
    expect(markdownToTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('renders emphasis, strong, and strikethrough', () => {
    expect(markdownToTelegramHtml('**bold** and *italic* and ~~strike~~')).toBe('<b>bold</b> and <i>italic</i> and <s>strike</s>')
  })

  it('nests inline formatting', () => {
    expect(markdownToTelegramHtml('**bold *italic***')).toBe('<b>bold <i>italic</i></b>')
  })

  it('renders inline code with entity escaping', () => {
    expect(markdownToTelegramHtml('`a & b < c`')).toBe('<code>a &amp; b &lt; c</code>')
  })

  it('renders a heading as a bold line', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
  })

  it('renders a fenced code block without a language', () => {
    expect(markdownToTelegramHtml('```\nline1\nline2\n```')).toBe('<pre>line1\nline2</pre>')
  })

  it('keeps a sanitized language on a fenced code block', () => {
    expect(markdownToTelegramHtml('```python extra\nprint(1)\n```')).toBe('<pre><code class="language-python">print(1)</code></pre>')
  })

  it('escapes code-block content', () => {
    expect(markdownToTelegramHtml('```\n<tag> & x\n```')).toBe('<pre>&lt;tag&gt; &amp; x</pre>')
  })

  it('flattens unordered and ordered lists', () => {
    expect(markdownToTelegramHtml('- a\n- b')).toBe('• a\n• b')
    expect(markdownToTelegramHtml('1. a\n2. b')).toBe('1. a\n2. b')
    expect(markdownToTelegramHtml('3. a\n4. b')).toBe('3. a\n4. b')
  })

  it('renders task list markers', () => {
    expect(markdownToTelegramHtml('- [x] done\n- [ ] todo')).toBe('☑ done\n☐ todo')
  })

  it('indents nested lists', () => {
    expect(markdownToTelegramHtml('- a\n  - b')).toBe('• a\n  • b')
  })

  it('renders empty and multi-paragraph list items', () => {
    expect(markdownToTelegramHtml('-\n  - b')).toBe('•\n  • b')
    expect(markdownToTelegramHtml('- first\n\n  second')).toBe('• first\n  second')
  })

  it('renders blockquotes', () => {
    expect(markdownToTelegramHtml('> quote')).toBe('<blockquote>quote</blockquote>')
    expect(markdownToTelegramHtml('> a\n> > b')).toBe('<blockquote>a\n<blockquote>b</blockquote></blockquote>')
  })

  it('flattens tables with a bold header', () => {
    expect(markdownToTelegramHtml('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('<b>a | b</b>\n1 | 2')
  })

  it('renders a thematic break', () => {
    expect(markdownToTelegramHtml('a\n\n---\n\nb')).toBe('a\n\n────────\n\nb')
  })

  it('renders safe links and drops unsafe ones', () => {
    expect(markdownToTelegramHtml('[x](https://e.com)')).toBe('<a href="https://e.com">x</a>')
    expect(markdownToTelegramHtml('[x](javascript:alert(1))')).toBe('x')
    expect(markdownToTelegramHtml('[x](mailto:a@b.c)')).toBe('x')
    expect(markdownToTelegramHtml('[x](https://e.com?a=1&b=2)')).toBe('<a href="https://e.com?a=1&amp;b=2">x</a>')
  })

  it('renders an empty link as nothing', () => {
    expect(markdownToTelegramHtml('[](https://e.com)')).toBe('')
  })

  it('renders autolinks', () => {
    expect(markdownToTelegramHtml('<https://e.com>')).toBe('<a href="https://e.com">https://e.com</a>')
  })

  it('resolves reference links and keeps unresolved ones literal', () => {
    expect(markdownToTelegramHtml('[x][id]\n\n[id]: https://e.com')).toBe('<a href="https://e.com">x</a>')
    expect(markdownToTelegramHtml('[x][missing]')).toBe('[x][missing]')
  })

  it('renders images as alt text or url fallback', () => {
    expect(markdownToTelegramHtml('![alt](https://e.com/i.png)')).toBe('alt')
    expect(markdownToTelegramHtml('![](https://e.com/i.png)')).toBe('https://e.com/i.png')
    expect(markdownToTelegramHtml('![alt][id]\n\n[id]: https://e.com/i.png')).toBe('alt')
    expect(markdownToTelegramHtml('![][id]\n\n[id]: https://e.com/i.png')).toBe('https://e.com/i.png')
  })

  it('keeps inline raw HTML literal', () => {
    expect(markdownToTelegramHtml('a <b>x</b> b')).toBe('a &lt;b&gt;x&lt;/b&gt; b')
  })

  it('keeps block raw HTML literal', () => {
    expect(markdownToTelegramHtml('<div>foo</div>')).toBe('&lt;div&gt;foo&lt;/div&gt;')
  })

  it('renders a hard break as a newline', () => {
    expect(markdownToTelegramHtml('a  \nb')).toBe('a\nb')
  })

  it('renders footnote references and skips their definitions', () => {
    expect(markdownToTelegramHtml('text[^1]\n\n[^1]: note')).toBe('text[^1]')
  })
})
