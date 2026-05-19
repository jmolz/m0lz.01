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
const BODY_FONT_SIZE = 20;
const LINE_HEIGHT = 30;
const CARD_MARGIN_X = 36;
const CARD_MARGIN_Y = 28;
const CARD_PADDING_X = 28;
const CARD_PADDING_Y = 24;
const CARD_GAP = 18;
const FIELD_GAP = 18;
const TABLE_TITLE_FONT_SIZE = 28;
const TABLE_TITLE_LINE_HEIGHT = 36;
const FIELD_LABEL_FONT_SIZE = 13;
const FIELD_LABEL_LINE_HEIGHT = 18;

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
    .replace(/(^|\W)__([^_\s][^_]*?[^_\s])__(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*?[^_\s])_(?=\W|$)/g, '$1$2')
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

function tableTitle(table: ParsedTable): string {
  return table.alt.replace(/^Table:\s*/, '').trim() || 'Table';
}

function renderLineTspans(
  lines: string[],
  x: number,
  y: number,
  options: {
    fontSize: number;
    lineHeight: number;
    cellX: number;
    cellWidth: number;
    rowY: number;
    rowHeight: number;
    paddingX: number;
  },
): string {
  return lines.map((line, lineIndex) => {
    const lineY = y + (lineIndex + 1) * options.lineHeight - Math.round(options.lineHeight * 0.24);
    const lineWidth = measureText(line, options.fontSize);
    return `<tspan x="${x}" y="${lineY}" data-cell-x="${options.cellX}" data-cell-width="${options.cellWidth}" ` +
      `data-line-width="${lineWidth}" data-row-y="${options.rowY}" data-row-height="${options.rowHeight}" ` +
      `data-padding-x="${options.paddingX}">${escapeXml(line)}</tspan>`;
  }).join('');
}

function renderCardSvg(table: ParsedTable): string {
  const contentX = CARD_MARGIN_X;
  const contentWidth = TABLE_WIDTH - CARD_MARGIN_X * 2;
  const fieldX = contentX + CARD_PADDING_X;
  const fieldWidth = contentWidth - CARD_PADDING_X * 2;
  const titleLines = wrapText(tableTitle(table), contentWidth, TABLE_TITLE_FONT_SIZE);
  const titleHeight = titleLines.length * TABLE_TITLE_LINE_HEIGHT;
  const cardModels = table.rows.map((row) => {
    const fields = table.header.map((header, index) => {
      const label = normalizeDisplayText(header).toUpperCase();
      const lines = wrapText(row[index] ?? '', fieldWidth, BODY_FONT_SIZE);
      const height = FIELD_LABEL_LINE_HEIGHT + 6 + lines.length * LINE_HEIGHT;
      return { label, lines, height };
    });
    const fieldsHeight = fields.reduce((sum, field) => sum + field.height, 0) + FIELD_GAP * Math.max(0, fields.length - 1);
    return {
      fields,
      height: CARD_PADDING_Y * 2 + fieldsHeight,
    };
  });
  const headerHeight = CARD_MARGIN_Y + titleHeight + 18;
  const cardsHeight = cardModels.reduce((sum, card) => sum + card.height, 0) + CARD_GAP * Math.max(0, cardModels.length - 1);
  const height = headerHeight + cardsHeight + CARD_MARGIN_Y;

  const titleTspans = renderLineTspans(titleLines, contentX, CARD_MARGIN_Y, {
    fontSize: TABLE_TITLE_FONT_SIZE,
    lineHeight: TABLE_TITLE_LINE_HEIGHT,
    cellX: contentX,
    cellWidth: contentWidth,
    rowY: 0,
    rowHeight: headerHeight,
    paddingX: 0,
  });

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TABLE_WIDTH}" height="${height}" viewBox="0 0 ${TABLE_WIDTH} ${height}" data-portable-table-layout="cards">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<text font-family="${FONT_FAMILY}" font-size="${TABLE_TITLE_FONT_SIZE}" font-weight="760" fill="${TEXT_FILL}">${titleTspans}</text>`,
  ];

  let y = headerHeight;
  cardModels.forEach((card, cardIndex) => {
    parts.push(
      `<rect x="${contentX}" y="${y}" width="${contentWidth}" height="${card.height}" rx="10" ` +
      `fill="${cardIndex % 2 === 0 ? BODY_FILL : STRIPE_FILL}" stroke="${CELL_BORDER}" stroke-width="1.5"/>`,
    );
    let fieldY = y + CARD_PADDING_Y;
    for (const field of card.fields) {
      parts.push(
        `<text x="${fieldX}" y="${fieldY + FIELD_LABEL_LINE_HEIGHT - 4}" font-family="${FONT_FAMILY}" ` +
        `font-size="${FIELD_LABEL_FONT_SIZE}" font-weight="760" letter-spacing="0.6" fill="#5f6368">${escapeXml(field.label)}</text>`,
      );
      const bodyY = fieldY + FIELD_LABEL_LINE_HEIGHT + 6;
      const tspans = renderLineTspans(field.lines, fieldX, bodyY, {
        fontSize: BODY_FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        cellX: contentX,
        cellWidth: contentWidth,
        rowY: y,
        rowHeight: card.height,
        paddingX: CARD_PADDING_X,
      });
      parts.push(
        `<text font-family="${FONT_FAMILY}" font-size="${BODY_FONT_SIZE}" font-weight="420" fill="${TEXT_FILL}">${tspans}</text>`,
      );
      fieldY += field.height + FIELD_GAP;
    }
    y += card.height + CARD_GAP;
  });

  parts.push('</svg>');
  return parts.join('');
}

function renderSvg(table: ParsedTable): string {
  if (table.header.length > MAX_RENDERED_COLUMNS) {
    return renderTooManyColumnsSvg(table);
  }
  return renderCardSvg(table);
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
