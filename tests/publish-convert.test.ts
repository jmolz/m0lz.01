import { describe, it, expect } from 'vitest';

import {
  mdxToMarkdown,
  removeImports,
  removeJsxComponents,
  resolveAssetUrls,
  stripFrontmatter,
} from '../src/core/publish/convert.js';

// All tests are pure — no DB, no FS, no mocks. Each helper is tested in
// isolation first, then the orchestrator mdxToMarkdown exercises the
// fence-aware composition.

describe('stripFrontmatter', () => {
  it('removes a leading YAML frontmatter block between two --- delimiters', () => {
    const input = [
      '---',
      'title: Hello',
      'description: World',
      '---',
      '',
      'Body content.',
    ].join('\n');
    expect(stripFrontmatter(input)).toBe('Body content.');
  });

  it('returns content unchanged when there is no leading frontmatter', () => {
    const input = 'No frontmatter here.\n\n---\n\nThis dash is a horizontal rule, not a fence.\n';
    expect(stripFrontmatter(input)).toBe(input);
  });
});

describe('removeImports', () => {
  it('removes a line that begins with `import`', () => {
    const input = [
      "import { Component } from '../components/x.js';",
      '',
      'Real body text.',
    ].join('\n');
    expect(removeImports(input).trim()).toBe('Real body text.');
  });
});

describe('removeJsxComponents', () => {
  it('removes self-closing JSX tags entirely', () => {
    const input = 'Before <Diagram src="./arch.svg" width={800} /> after.';
    expect(removeJsxComponents(input)).toBe('Before  after.');
  });

  it('removes block JSX tags while preserving inner text content', () => {
    const input = '<Callout type="info">Hello readers</Callout>';
    expect(removeJsxComponents(input)).toBe('Hello readers');
  });
});

describe('resolveAssetUrls', () => {
  it('transforms ./assets/x.svg image references to an absolute hub URL', () => {
    const input = '![Arch](./assets/arch.svg)';
    const out = resolveAssetUrls(input, 'my-post', 'https://m0lz.dev');
    expect(out).toBe('![Arch](https://m0lz.dev/writing/my-post/assets/arch.svg)');
  });

  it('transforms assets/x.svg (no ./ prefix) to the same absolute URL', () => {
    const input = '![Arch](assets/arch.svg)';
    const out = resolveAssetUrls(input, 'my-post', 'https://m0lz.dev');
    expect(out).toBe('![Arch](https://m0lz.dev/writing/my-post/assets/arch.svg)');
  });

  it('leaves absolute URLs untouched', () => {
    const input = '![External](https://example.com/img.svg)';
    expect(resolveAssetUrls(input, 'my-post', 'https://m0lz.dev')).toBe(input);
  });
});

describe('mdxToMarkdown — end-to-end composition', () => {
  it('strips frontmatter, removes imports, strips JSX, resolves URLs outside fences', () => {
    const input = [
      '---',
      'title: Example',
      '---',
      '',
      "import { Callout } from '../components/Callout.js';",
      '',
      '<Callout>Visual warning</Callout>',
      '',
      '![Arch](./assets/arch.svg)',
    ].join('\n');
    const out = mdxToMarkdown(input, 'example', 'https://m0lz.dev');

    expect(out).not.toContain('---');
    expect(out).not.toContain('import');
    expect(out).not.toContain('<Callout');
    expect(out).toContain('Visual warning');
    expect(out).toContain('https://m0lz.dev/writing/example/assets/arch.svg');
  });

  it('preserves content inside ``` fences verbatim — imports, JSX, and relative paths pass through', () => {
    const input = [
      'Outside: ./assets/a.svg becomes absolute',
      '',
      '```typescript',
      "import { foo } from 'bar';",
      '<Component />',
      './assets/inside.svg',
      '```',
      '',
      'Outside again: ./assets/b.svg becomes absolute',
    ].join('\n');
    const out = mdxToMarkdown(input, 'fence-test', 'https://m0lz.dev');

    // Outside the fence — asset refs were rewritten. (Not using Markdown image
    // syntax here, so resolveAssetUrls leaves the plain string alone, but we
    // confirm the fence body is unchanged below.)
    expect(out).toContain("import { foo } from 'bar';");
    expect(out).toContain('<Component />');
    expect(out).toContain('./assets/inside.svg');
  });

  it('treats a quadruple-backtick fence as a single fence containing triple-backtick lines', () => {
    const input = [
      '````',
      'code starts',
      '',
      '```inline triple fence should not close the outer',
      'still inside',
      '',
      '````',
      'after outer fence ends',
    ].join('\n');
    const out = mdxToMarkdown(input, 'nested-fence', 'https://m0lz.dev');

    // The inline triple backtick line must still be present — the outer
    // quadruple fence is not closed by a triple.
    expect(out).toContain('```inline triple fence should not close the outer');
    expect(out).toContain('still inside');
    expect(out).toContain('after outer fence ends');
  });

  it('collapses 3+ consecutive blank lines into exactly two', () => {
    const input = 'first\n\n\n\n\nsecond\n';
    const out = mdxToMarkdown(input, 'blanks', 'https://m0lz.dev');
    // After collapse: single \n\n between non-empty lines. Assert we never see
    // three consecutive newlines.
    expect(/\n{3,}/.test(out)).toBe(false);
    expect(out).toContain('first');
    expect(out).toContain('second');
  });
});
