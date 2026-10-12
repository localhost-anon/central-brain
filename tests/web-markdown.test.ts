import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser JS module without types
import { renderMarkdown, renderInline } from '../web/markdown.js';

const md = (s: string): string => renderMarkdown(s);

describe('thread markdown renderer', () => {
  it('renders bold, italic, inline code, fences, lists and links as elements', () => {
    const html = md([
      'This is **bold**, *italic*, _also italic_ and `npm test`.',
      '',
      '```',
      'const x = 1;',
      '```',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      'See [the docs](https://example.com/a?b=1&c=2) or https://pscloud.dev/x.',
    ].join('\n'));
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<em>also italic</em>');
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('<pre><code>const x = 1;</code></pre>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a>');
    expect(html).toContain('<a href="https://pscloud.dev/x" target="_blank" rel="noopener noreferrer">https://pscloud.dev/x</a>.');
  });

  it('shows headings as bold lines and pipe tables as monospace text', () => {
    expect(md('## Plan')).toBe('<p class="md-h"><strong>Plan</strong></p>');
    expect(md('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<pre class="md-table">| a | b |\n|---|---|\n| 1 | 2 |</pre>');
  });

  it('keeps line breaks inside a paragraph and a numbered list start', () => {
    expect(md('line one\nline two')).toBe('<p>line one<br>line two</p>');
    expect(md('3. third\n4. fourth')).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
  });

  it('escapes HTML so a message cannot inject markup', () => {
    const html = md('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n**<b>x</b>**\n`<i>`\n```\n<svg onload=1>\n```');
    expect(html).not.toMatch(/<(script|img|svg|b|i)[\s>]/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(html).toContain('<code>&lt;i&gt;</code>');
    expect(html).toContain('<pre><code>&lt;svg onload=1&gt;</code></pre>');
  });

  it('cannot break out of a link href', () => {
    const html = renderInline('[x](https://a.dev/"onmouseover="alert(1))');
    expect(html).not.toContain('" onmouseover');
    expect(html).toContain('&quot;onmouseover=&quot;');
  });

  it('leaves javascript: and data: links as plain text', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
      const html = renderInline(`[click](${url})`);
      expect(html).not.toContain('<a');
      expect(html).toContain('[click](');
    }
  });

  it('handles odd or unclosed markdown without losing text', () => {
    expect(md('a lone ** here')).toBe('<p>a lone ** here</p>');
    expect(md('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
    expect(md('snake_case_name')).toBe('<p>snake_case_name</p>');
    expect(md('`a *b* **c**`')).toBe('<p><code>a *b* **c**</code></p>');
    expect(md('before\n```js\nlet a = 1;\nlet b = 2;')).toBe('<p>before</p><pre><code>let a = 1;\nlet b = 2;</code></pre>');
    expect(md('unclosed `tick and [label](no-close')).toBe('<p>unclosed `tick and [label](no-close</p>');
    expect(md('')).toBe('');
    expect(md(undefined as unknown as string)).toBe('');
    expect(md('nul\u0000byte')).toBe('<p>nulbyte</p>');
  });
});
