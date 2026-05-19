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

function tspanMetrics(svg: string): Array<Record<string, number>> {
  const metrics: Array<Record<string, number>> = [];
  for (const match of svg.matchAll(/<tspan\s+([^>]*)>/g)) {
    const attrs: Record<string, number> = {};
    for (const attr of match[1].matchAll(/([a-z-]+)="([^"]+)"/g)) {
      attrs[attr[1]] = Number(attr[2]);
    }
    metrics.push(attrs);
  }
  return metrics;
}

function expectLinesInsideCells(svg: string): void {
  const metrics = tspanMetrics(svg);
  expect(metrics.length).toBeGreaterThan(0);
  for (const line of metrics) {
    expect(line.x).toBeGreaterThanOrEqual(line['data-cell-x'] + line['data-padding-x']);
    expect(line.x + line['data-line-width']).toBeLessThanOrEqual(
      line['data-cell-x'] + line['data-cell-width'] - line['data-padding-x'],
    );
    expect(line.y).toBeGreaterThan(line['data-row-y']);
    expect(line.y).toBeLessThanOrEqual(line['data-row-y'] + line['data-row-height']);
  }
}

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
    expect(metadata.width).toBeGreaterThanOrEqual(1192);
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

  it('can emit upload placeholders instead of public URL image embeds', () => {
    const derived = derivePortableTables([
      '| Runtime | Median |',
      '| --- | ---: |',
      '| Node | 12ms |',
    ].join('\n'), {
      slug: 'placeholder',
      baseUrl: 'https://m0lz.dev',
      title: 'Placeholder',
      referenceMode: 'placeholder',
      platformName: 'Medium',
      checklistPath: 'medium-upload-checklist.md',
    });

    expect(derived.tables).toHaveLength(1);
    expect(derived.markdown).toContain('Table image upload required for Medium');
    expect(derived.markdown).toContain('medium-upload-checklist.md');
    expect(derived.markdown).not.toContain('https://m0lz.dev/writing/placeholder/assets/portable-table-');
    expect(derived.markdown).not.toContain('| Runtime | Median |');
  });

  it('wraps long evidence and boundary cells without overflowing layout metrics', async () => {
    const dir = setup();
    const evidence =
      'This check includes a long evidence sentence with enough concrete detail to overflow the old fixed row renderer and collide with the neighboring Boundary column.';
    const boundary =
      'The boundary text explains the exact publication contract for Medium and Substack upload workflows without relying on arbitrary public image URL embeds.';
    const markdown = [
      '## Screenshot Shape',
      '',
      '| Check | Result | Evidence | Boundary |',
      '| --- | --- | --- | --- |',
      `| C1 | Pass | ${evidence} | ${boundary} |`,
    ].join('\n');

    const derived = derivePortableTables(markdown, {
      slug: 'long-cells',
      baseUrl: 'https://m0lz.dev',
      title: 'Long Cells',
    });
    expect(derived.tables).toHaveLength(1);
    const svg = derived.tables[0].svg;
    expect(svg.match(/<tspan/g)?.length ?? 0).toBeGreaterThan(8);
    expect(svg).not.toContain(evidence);
    expect(svg).not.toContain(boundary);
    expectLinesInsideCells(svg);

    const assets = await writePortableTableAssets(derived, dir);
    const pngPath = join(dir, assets[0].path.replace(/^assets\//, ''));
    const metadata = await sharp(readFileSync(pngPath)).metadata();
    expect(metadata.width).toBeGreaterThanOrEqual(1192);
    expect(metadata.height).toBeGreaterThan(42 * (derived.tables[0].row_count + 1));
  });

  it('hard-wraps long tokens and keeps many-column layouts inside bounds', () => {
    const token = 'SuperLongBoundaryTokenWithoutNaturalBreaksThatPreviouslyWouldBleedAcrossCells'.repeat(3);
    const longToken = derivePortableTables([
      '| Check | Boundary |',
      '| --- | --- |',
      `| C2 | ${token} |`,
    ].join('\n'), {
      slug: 'long-token',
      baseUrl: 'https://m0lz.dev',
      title: 'Long Token',
    });
    expect(longToken.tables[0].svg).not.toContain(token);
    expectLinesInsideCells(longToken.tables[0].svg);

    const headers = Array.from({ length: 10 }, (_, i) => `Column ${i + 1}`);
    const row = headers.map((_, i) => `value ${i + 1} with wrapping text`);
    const many = derivePortableTables([
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      `| ${row.join(' | ')} |`,
    ].join('\n'), {
      slug: 'many-columns',
      baseUrl: 'https://m0lz.dev',
      title: 'Many Columns',
    });
    expect(many.tables[0].svg).not.toContain('data-portable-table-warning');
    expectLinesInsideCells(many.tables[0].svg);
  });

  it('marks tables beyond the explicit portable column limit instead of rendering overlap', () => {
    const headers = Array.from({ length: 11 }, (_, i) => `Column ${i + 1}`);
    const derived = derivePortableTables([
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      `| ${headers.map(() => 'value').join(' | ')} |`,
    ].join('\n'), {
      slug: 'too-wide',
      baseUrl: 'https://m0lz.dev',
      title: 'Too Wide',
    });

    expect(derived.tables).toHaveLength(1);
    expect(derived.tables[0].svg).toContain('data-portable-table-warning="too-many-columns"');
    expect(derived.tables[0].svg).toContain('Column limit: 10');
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
