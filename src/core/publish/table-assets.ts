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

export type PortableTableReferenceMode = 'public-url' | 'local-upload' | 'placeholder';

export interface DerivePortableTablesOptions {
  slug: string;
  baseUrl: string;
  title: string;
  referenceMode?: PortableTableReferenceMode;
  platformName?: string;
  checklistPath?: string;
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

const TABLE_WIDTH = 1192;
const MAX_RENDERED_COLUMNS = 10;
const OUTER_BORDER = '#cfcfcf';
const CELL_BORDER = '#d8d8d8';
const HEADER_FILL = '#171717';
const BODY_FILL = '#ffffff';
const STRIPE_FILL = '#f7f7f7';
const TEXT_FILL = '#171717';
const HEADER_TEXT_FILL = '#ffffff';
const FONT_FAMILY = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
const HEADER_FONT_SIZE = 17;
const BODY_FONT_SIZE = 16;
const LINE_HEIGHT = 22;
const CELL_PADDING_X = 18;
const CELL_PADDING_Y = 16;
const MIN_BODY_ROW_HEIGHT = 56;
const MIN_HEADER_ROW_HEIGHT = 60;

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

function normalizeDisplayText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

function measureText(value: string, fontSize: number): number {
  let total = 0;
  for (const char of value) {
    if (/[A-Z0-9]/.test(char)) total += fontSize * 0.61;
    else if (/[il.,:;|!]/.test(char)) total += fontSize * 0.31;
    else if (/\s/.test(char)) total += fontSize * 0.34;
    else total += fontSize * 0.55;
  }
  return Math.ceil(total);
}

function hardWrapToken(token: string, maxWidth: number, fontSize: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const char of token) {
    const candidate = `${current}${char}`;
    if (current && measureText(candidate, fontSize) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

function wrapText(value: string, maxWidth: number, fontSize: number): string[] {
  const normalized = normalizeDisplayText(value);
  if (!normalized) return [''];
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const pieces = measureText(word, fontSize) > maxWidth
      ? hardWrapToken(word, maxWidth, fontSize)
      : [word];
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (current && measureText(candidate, fontSize) > maxWidth) {
        lines.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function headerWeight(value: string): number {
  const normalized = normalizeDisplayText(value).toLowerCase();
  if (/\b(evidence|boundary|rationale|notes?|result|finding|constraint)\b/.test(normalized)) return 2.2;
  if (/\b(check|id|status|type)\b/.test(normalized)) return 0.75;
  return 1;
}

function baseMinimumWidth(columnCount: number): number {
  if (columnCount <= 4) return 150;
  if (columnCount <= 8) return 108;
  return 84;
}

function computeColumnWidths(table: ParsedTable): number[] {
  const columnCount = table.header.length;
  const minWidth = Math.min(baseMinimumWidth(columnCount), Math.floor(TABLE_WIDTH / columnCount));
  const reserved = minWidth * columnCount;
  const remaining = Math.max(0, TABLE_WIDTH - reserved);
  const rows = [table.header, ...table.rows];
  const rawWeights = table.header.map((header, index) => {
    const maxText = Math.max(
      ...rows.map((row) => measureText(normalizeDisplayText(row[index] ?? ''), BODY_FONT_SIZE)),
    );
    return Math.max(1, Math.sqrt(maxText)) * headerWeight(header);
  });
  const totalWeight = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  const widths = rawWeights.map((weight) => minWidth + Math.floor((remaining * weight) / totalWeight));
  const correction = TABLE_WIDTH - widths.reduce((sum, value) => sum + value, 0);
  widths[widths.length - 1] += correction;
  return widths;
}

function renderTooManyColumnsSvg(table: ParsedTable): string {
  const message = `Table has ${table.header.length} columns; use the canonical article for the semantic table.`;
  const height = 168;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TABLE_WIDTH}" height="${height}" viewBox="0 0 ${TABLE_WIDTH} ${height}" data-portable-table-warning="too-many-columns">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="0" y="0" width="${TABLE_WIDTH}" height="${height}" fill="#ffffff" stroke="${OUTER_BORDER}" stroke-width="2"/>`,
    `<rect x="0" y="0" width="${TABLE_WIDTH}" height="58" fill="${HEADER_FILL}"/>`,
    `<text x="24" y="37" font-family="${FONT_FAMILY}" font-size="18" font-weight="700" fill="${HEADER_TEXT_FILL}">Portable table upload notice</text>`,
    `<text x="24" y="94" font-family="${FONT_FAMILY}" font-size="16" fill="${TEXT_FILL}">${escapeXml(message)}</text>`,
    `<text x="24" y="124" font-family="${FONT_FAMILY}" font-size="15" fill="#525252">Column limit: ${MAX_RENDERED_COLUMNS}. Source columns: ${escapeXml(table.header.join(', '))}</text>`,
    '</svg>',
  ].join('');
}

function renderSvg(table: ParsedTable): string {
  if (table.header.length > MAX_RENDERED_COLUMNS) {
    return renderTooManyColumnsSvg(table);
  }

  const rows = [table.header, ...table.rows];
  const columnWidths = computeColumnWidths(table);
  const xStarts = columnWidths.reduce<number[]>((acc, value, index) => {
    acc.push(index === 0 ? 0 : acc[index - 1] + columnWidths[index - 1]);
    return acc;
  }, []);
  const wrapped = rows.map((row, rowIndex) =>
    row.map((cell, colIndex) => {
      const fontSize = rowIndex === 0 ? HEADER_FONT_SIZE : BODY_FONT_SIZE;
      return wrapText(cell, columnWidths[colIndex] - CELL_PADDING_X * 2, fontSize);
    }),
  );
  const rowHeights = wrapped.map((row, rowIndex) => {
    const lineCount = Math.max(...row.map((lines) => lines.length));
    const computed = CELL_PADDING_Y * 2 + lineCount * LINE_HEIGHT;
    return Math.max(rowIndex === 0 ? MIN_HEADER_ROW_HEIGHT : MIN_BODY_ROW_HEIGHT, computed);
  });
  const yStarts = rowHeights.reduce<number[]>((acc, value, index) => {
    acc.push(index === 0 ? 0 : acc[index - 1] + rowHeights[index - 1]);
    return acc;
  }, []);
  const height = rowHeights.reduce((sum, value) => sum + value, 0);

  const rects: string[] = [];
  const texts: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let colIndex = 0; colIndex < columnWidths.length; colIndex += 1) {
      const x = xStarts[colIndex];
      const y = yStarts[rowIndex];
      const fontSize = rowIndex === 0 ? HEADER_FONT_SIZE : BODY_FONT_SIZE;
      const lines = wrapped[rowIndex][colIndex];
      rects.push(
        `<rect x="${x}" y="${y}" width="${columnWidths[colIndex]}" height="${rowHeights[rowIndex]}" ` +
        `fill="${rowIndex === 0 ? '#171717' : rowIndex % 2 === 0 ? '#f6f6f6' : '#ffffff'}" ` +
        `stroke="${CELL_BORDER}" stroke-width="1"/>`,
      );
      const tspans = lines.map((line, lineIndex) => {
        const lineX = x + CELL_PADDING_X;
        const lineY = y + CELL_PADDING_Y + (lineIndex + 1) * LINE_HEIGHT - 4;
        const lineWidth = measureText(line, fontSize);
        return `<tspan x="${lineX}" y="${lineY}" data-cell-x="${x}" data-cell-width="${columnWidths[colIndex]}" ` +
          `data-line-width="${lineWidth}" data-row-y="${y}" data-row-height="${rowHeights[rowIndex]}" ` +
          `data-padding-x="${CELL_PADDING_X}">${escapeXml(line)}</tspan>`;
      }).join('');
      texts.push(
        `<text font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${rowIndex === 0 ? 700 : 400}" ` +
        `fill="${rowIndex === 0 ? HEADER_TEXT_FILL : TEXT_FILL}">${tspans}</text>`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TABLE_WIDTH}" height="${height}" viewBox="0 0 ${TABLE_WIDTH} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="0" y="0" width="${TABLE_WIDTH}" height="${height}" fill="none" stroke="${OUTER_BORDER}" stroke-width="2"/>`,
    ...rects,
    ...texts,
    '</svg>',
  ].join('');
}

function publicTableUrl(options: Pick<DerivePortableTablesOptions, 'baseUrl' | 'slug'>, path: string): string {
  return `${options.baseUrl.replace(/\/+$/, '')}/writing/${options.slug}/${path}`;
}

function renderTableReference(
  table: ParsedTable,
  path: string,
  options: DerivePortableTablesOptions,
): string {
  const mode = options.referenceMode ?? 'public-url';
  if (mode === 'public-url') {
    return `![${table.alt}](${publicTableUrl(options, path)})`;
  }
  if (mode === 'local-upload') {
    return `![${table.alt}](./${path})`;
  }
  const platform = options.platformName ?? 'platform';
  const checklist = options.checklistPath ?? 'upload-checklist.md';
  return [
    `> Table image upload required for ${platform}: \`${path}\`.`,
    `> See \`${checklist}\` for alt text, caption, canonical URL, and upload instructions.`,
  ].join('\n');
}

export function derivePortableTables(
  markdown: string,
  options: DerivePortableTablesOptions,
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
    out.push(renderTableReference(parsed, path, options));
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
