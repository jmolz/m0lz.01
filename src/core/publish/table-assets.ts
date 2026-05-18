import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

export interface PortableTableSource {
  path: string;
  sha256: string;
  alt: string;
  source_hash: string;
  row_count: number;
  column_count: number;
  svg: string;
}

export interface PortableTableAsset {
  path: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  alt: string;
  source_hash: string;
  row_count: number;
  column_count: number;
}

export interface DerivedPortableTables {
  markdown: string;
  tables: PortableTableSource[];
}

interface ParsedTable {
  startLine: number;
  endLine: number;
  header: string[];
  align: string[];
  rows: string[][];
  alt: string;
}

interface FenceState {
  marker: '`' | '~';
  length: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

function detectFenceOpen(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const run = match[1];
  return { marker: run[0] as '`' | '~', length: run.length };
}

function detectFenceClose(line: string, state: FenceState): boolean {
  const marker = state.marker === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${marker}{${state.length},}\\s*$`).test(line);
}

function isIndentedMarkdownContainer(line: string): boolean {
  return /^\s*(?:>|[-+*]\s+|\d+\.\s+)/.test(line);
}

function splitCells(row: string): string[] | null {
  const trimmed = row.trim();
  if (!trimmed.includes('|') || isIndentedMarkdownContainer(trimmed)) return null;

  const cells: string[] = [];
  let current = '';
  let codeRunLength = 0;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }
    if (char === '`') {
      let runLength = 1;
      while (trimmed[i + runLength] === '`') runLength += 1;
      if (codeRunLength === 0) {
        codeRunLength = runLength;
      } else if (runLength === codeRunLength) {
        codeRunLength = 0;
      }
      current += '`'.repeat(runLength);
      i += runLength - 1;
      continue;
    }
    if (char === '|' && codeRunLength === 0) {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));

  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|')) cells.pop();
  return cells.length >= 2 ? cells : null;
}

function parseSeparator(row: string, columnCount: number): string[] | null {
  const cells = splitCells(row);
  if (!cells) return null;
  const padded = normalizeRow(cells, columnCount);
  if (!padded) return null;
  const align: string[] = [];
  for (const cell of padded) {
    const normalized = cell.trim();
    if (!/^:?-{3,}:?$/.test(normalized)) return null;
    if (normalized.startsWith(':') && normalized.endsWith(':')) align.push('center');
    else if (normalized.endsWith(':')) align.push('right');
    else align.push('left');
  }
  return align;
}

function normalizeRow(cells: string[], columnCount: number): string[] | null {
  if (cells.length > columnCount) return null;
  return cells.length === columnCount
    ? cells
    : [...cells, ...Array.from({ length: columnCount - cells.length }, () => '')];
}

function nearestHeading(lines: string[], beforeLine: number, fallback: string): string {
  let fence: FenceState | null = null;
  const headingByLine = new Map<number, string>();
  for (let i = 0; i < beforeLine; i += 1) {
    const line = lines[i];
    if (fence) {
      if (detectFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = detectFenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) headingByLine.set(i, match[1].trim());
  }
  const latest = [...headingByLine.entries()].sort((a, b) => b[0] - a[0])[0];
  return latest?.[1] ?? fallback;
}

function parseTableAt(lines: string[], startLine: number, title: string): ParsedTable | null {
  const header = splitCells(lines[startLine]);
  if (!header) return null;
  const align = parseSeparator(lines[startLine + 1] ?? '', header.length);
  if (!align) return null;

  const rows: string[][] = [];
  let endLine = startLine + 1;
  for (let i = startLine + 2; i < lines.length; i += 1) {
    const cells = splitCells(lines[i]);
    if (!cells) break;
    const normalized = normalizeRow(cells, header.length);
    if (!normalized) break;
    rows.push(normalized);
    endLine = i;
  }
  if (rows.length === 0) return null;

  return {
    startLine,
    endLine,
    header,
    align,
    rows,
    alt: `Table: ${nearestHeading(lines, startLine, title)}`,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textWidth(value: string): number {
  const plain = value.replace(/`([^`]+)`/g, '$1');
  return Math.min(280, Math.max(110, plain.length * 7 + 32));
}

function renderSvg(table: ParsedTable): string {
  const rows = [table.header, ...table.rows];
  const columnWidths = table.header.map((_, index) =>
    Math.max(...rows.map((row) => textWidth(row[index] ?? ''))),
  );
  const rowHeight = 42;
  const width = columnWidths.reduce((sum, value) => sum + value, 0);
  const height = rowHeight * rows.length;
  const xStarts = columnWidths.reduce<number[]>((acc, value, index) => {
    acc.push(index === 0 ? 0 : acc[index - 1] + columnWidths[index - 1]);
    return acc;
  }, []);

  const rects: string[] = [];
  const texts: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let colIndex = 0; colIndex < columnWidths.length; colIndex += 1) {
      const x = xStarts[colIndex];
      const y = rowIndex * rowHeight;
      rects.push(
        `<rect x="${x}" y="${y}" width="${columnWidths[colIndex]}" height="${rowHeight}" ` +
        `fill="${rowIndex === 0 ? '#171717' : rowIndex % 2 === 0 ? '#f6f6f6' : '#ffffff'}" ` +
        `stroke="#d4d4d4" stroke-width="1"/>`,
      );
      texts.push(
        `<text x="${x + 14}" y="${y + 26}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" ` +
        `font-size="14" font-weight="${rowIndex === 0 ? 700 : 400}" ` +
        `fill="${rowIndex === 0 ? '#ffffff' : '#171717'}">${escapeXml(row[colIndex] ?? '')}</text>`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    ...rects,
    ...texts,
    '</svg>',
  ].join('');
}

export function derivePortableTables(
  markdown: string,
  options: { slug: string; baseUrl: string; title: string },
): DerivedPortableTables {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  const tables: PortableTableSource[] = [];
  let fence: FenceState | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      if (detectFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = detectFenceOpen(line);
    if (open) {
      fence = open;
      out.push(line);
      continue;
    }

    const parsed = parseTableAt(lines, i, options.title);
    if (!parsed) {
      out.push(line);
      continue;
    }

    const canonical = {
      header: parsed.header,
      align: parsed.align,
      rows: parsed.rows,
    };
    const sourceHash = sha256(stableJson(canonical));
    const filename = `portable-table-${sourceHash.slice(0, 12)}.png`;
    const path = `assets/${filename}`;
    const svg = renderSvg(parsed);
    tables.push({
      path,
      sha256: '',
      alt: parsed.alt,
      source_hash: sourceHash,
      row_count: parsed.rows.length,
      column_count: parsed.header.length,
      svg,
    });
    out.push(`![${parsed.alt}](${options.baseUrl.replace(/\/+$/, '')}/writing/${options.slug}/${path})`);
    i = parsed.endLine;
  }

  return { markdown: out.join('\n'), tables };
}

export async function writePortableTableAssets(
  derived: Pick<DerivedPortableTables, 'tables'>,
  assetsDir: string,
): Promise<PortableTableAsset[]> {
  const unique = new Map<string, PortableTableSource>();
  for (const table of derived.tables) unique.set(table.path, table);
  mkdirSync(assetsDir, { recursive: true });

  const expected = new Set([...unique.values()].map((table) => table.path.replace(/^assets\//, '')));
  for (const entry of readdirSync(assetsDir)) {
    if (/^portable-table-[0-9a-f]{12}\.png$/.test(entry) && !expected.has(entry)) {
      rmSync(join(assetsDir, entry), { force: true });
    }
  }

  const written: PortableTableAsset[] = [];
  for (const table of unique.values()) {
    const filename = table.path.replace(/^assets\//, '');
    const outputPath = join(assetsDir, filename);
    const bytes = await sharp(Buffer.from(table.svg)).png().toBuffer();
    if (!existsSync(outputPath) || sha256(readFileSync(outputPath)) !== sha256(bytes)) {
      writeFileSync(outputPath, bytes);
    }
    const metadata = await sharp(readFileSync(outputPath)).metadata();
    const stats = statSync(outputPath);
    written.push({
      path: table.path,
      sha256: sha256(readFileSync(outputPath)),
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      bytes: stats.size,
      alt: table.alt,
      source_hash: table.source_hash,
      row_count: table.row_count,
      column_count: table.column_count,
    });
  }
  return written.sort((a, b) => a.path.localeCompare(b.path));
}
