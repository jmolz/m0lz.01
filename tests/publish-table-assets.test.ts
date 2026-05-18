import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import sharp from 'sharp';

import {
  derivePortableTables,
  writePortableTableAssets,
} from '../src/core/publish/table-assets.js';

let tempDir: string | undefined;

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'publish-table-assets-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('portable table assets', () => {
  it('replaces a simple Markdown table with a deterministic image link and writes a valid PNG', async () => {
    const dir = setup();
    const markdown = [
      '# Results',
      '',
      '| Name | Score |',
      '| --- | ---: |',
      '| Alpha | 10 |',
      '| Beta | 12 |',
    ].join('\n');

    const derived = derivePortableTables(markdown, {
      slug: 'table-post',
      baseUrl: 'https://m0lz.dev',
      title: 'Table Post',
    });
    expect(derived.tables).toHaveLength(1);
    expect(derived.markdown).toContain('![Table: Results](https://m0lz.dev/writing/table-post/assets/portable-table-');
    expect(derived.markdown).not.toContain('| Name | Score |');

    const assets = await writePortableTableAssets(derived, dir);
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toMatch(/^assets\/portable-table-[0-9a-f]{12}\.png$/);
    const pngPath = join(dir, assets[0].path.replace(/^assets\//, ''));
    expect(existsSync(pngPath)).toBe(true);
    const metadata = await sharp(readFileSync(pngPath)).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });

  it('uses the same filename and hash on repeated derivation', () => {
    const markdown = [
      '| Name | Score |',
      '| --- | ---: |',
      '| Alpha | 10 |',
    ].join('\n');
    const first = derivePortableTables(markdown, { slug: 'stable', baseUrl: 'https://m0lz.dev', title: 'Stable' });
    const second = derivePortableTables(markdown, { slug: 'stable', baseUrl: 'https://m0lz.dev', title: 'Stable' });

    expect(first.tables[0].path).toBe(second.tables[0].path);
    expect(first.tables[0].source_hash).toBe(second.tables[0].source_hash);
  });

  it('leaves code-fenced table-looking text untouched', () => {
    const markdown = [
      '```md',
      '| Name | Score |',
      '| --- | ---: |',
      '| Alpha | 10 |',
      '```',
    ].join('\n');
    const derived = derivePortableTables(markdown, {
      slug: 'fenced',
      baseUrl: 'https://m0lz.dev',
      title: 'Fenced',
    });

    expect(derived.tables).toHaveLength(0);
    expect(derived.markdown).toBe(markdown);
  });

  it('parses optional edge pipes, escaped pipes, inline-code pipes, and alignment rows', () => {
    const markdown = [
      '## Parser',
      '',
      'Name | Note | Code',
      ':--- | :---: | ---:',
      'Alpha | escaped \\| pipe | ``a | b``',
    ].join('\n');
    const derived = derivePortableTables(markdown, {
      slug: 'parser',
      baseUrl: 'https://m0lz.dev/',
      title: 'Parser',
    });

    expect(derived.tables).toHaveLength(1);
    expect(derived.tables[0].alt).toBe('Table: Parser');
    expect(derived.tables[0].column_count).toBe(3);
    expect(derived.markdown).toContain('https://m0lz.dev/writing/parser/assets/');
  });

  it('leaves blockquote, list, and malformed table-like text unchanged', () => {
    const markdown = [
      '> | Quoted | Table |',
      '> | --- | --- |',
      '> | A | B |',
      '',
      '- | List | Row |',
      '  | --- | --- |',
      '  | A | B |',
      '',
      '| No | Body |',
      '| --- | --- |',
    ].join('\n');
    const derived = derivePortableTables(markdown, {
      slug: 'skip',
      baseUrl: 'https://m0lz.dev',
      title: 'Skip',
    });

    expect(derived.tables).toHaveLength(0);
    expect(derived.markdown).toBe(markdown);
  });

  it('removes stale generator-owned portable table PNGs from the local assets directory', async () => {
    const dir = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'portable-table-deadbeef0000.png'), Buffer.from('stale'));
    writeFileSync(join(dir, 'custom.png'), Buffer.from('keep'));
    const derived = derivePortableTables([
      '| Name | Score |',
      '| --- | --- |',
      '| Alpha | 10 |',
    ].join('\n'), {
      slug: 'cleanup',
      baseUrl: 'https://m0lz.dev',
      title: 'Cleanup',
    });

    await writePortableTableAssets(derived, dir);
    const files = readdirSync(dir).sort();
    expect(files).toContain('custom.png');
    expect(files).not.toContain('portable-table-deadbeef0000.png');
    expect(files.some((file) => /^portable-table-[0-9a-f]{12}\.png$/.test(file))).toBe(true);
  });
});
