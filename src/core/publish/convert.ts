// Pure MDX → plain Markdown converter for cross-posting platforms
// (Dev.to, Medium, Substack) that do not understand MDX/JSX.
//
// Design goals:
//   - Pure function — no DB, no filesystem, no network.
//   - Individually testable helpers for frontmatter strip, import removal,
//     JSX removal, and asset URL resolution.
//   - Fence-aware: JSX stripping and URL resolution must NOT touch code
//     samples. A fence-opening line uses ``` or ~~~ (>=3 of the same char),
//     and closing requires the SAME marker char with AT LEAST as many
//     markers as the opening — this handles ``` inside ```` fences.
//
// The implementation splits incoming content into a sequence of "segments"
// according to fence state. Inside-fence segments pass through unmodified;
// outside-fence segments receive import removal (line-level) + JSX removal
// + URL resolution.

// Strip a leading YAML frontmatter block. A frontmatter block is defined as
// a document that opens with `---` on its own line (optionally followed by
// whitespace) and has a matching `---` terminator. Returns the original
// content unchanged when no leading frontmatter is present.
export function stripFrontmatter(content: string): string {
  // Match an opening fence on line 1. We anchor on the very start of the
  // content to avoid catching `---` used as a horizontal rule further down.
  const leadingMatch = content.match(/^---\s*\r?\n/);
  if (!leadingMatch) return content;
  const afterOpen = leadingMatch[0].length;
  // Find the closing `---` on its own line.
  const closePattern = /\r?\n---\s*(?:\r?\n|$)/;
  const rest = content.slice(afterOpen);
  const closeMatch = rest.match(closePattern);
  if (!closeMatch) {
    // Malformed frontmatter — return the content unchanged so the caller
    // can see there was nothing to strip.
    return content;
  }
  const closeStart = closeMatch.index ?? 0;
  const closeEnd = closeStart + closeMatch[0].length;
  return rest.slice(closeEnd);
}

// Remove ES-module import statement lines. Caller is responsible for fence
// awareness — this helper operates on the entire input and trims any line
// that begins with `import ` (or `import{`), followed by a balanced trailing
// semicolon or end of line. Multi-line imports (spanning lines) are joined
// naively: any line whose first non-whitespace token is `import` starts a
// removal region that ends on the first `;` or the first blank line.
export function removeImports(content: string): string {
  const lines = content.split(/\r?\n/);
  const keep: string[] = [];
  let inImport = false;
  for (const line of lines) {
    if (!inImport) {
      if (/^\s*import\b/.test(line)) {
        // Single-line import ends with a semicolon (optionally trailing
        // whitespace). Multi-line imports have the closing brace+semicolon
        // on a later line.
        if (/;\s*$/.test(line)) {
          // Whole import on one line — drop it.
          continue;
        }
        inImport = true;
        continue;
      }
      keep.push(line);
    } else {
      // Already dropping — keep dropping until the closing semicolon or a
      // blank line (malformed recovery).
      if (/;\s*$/.test(line) || line.trim() === '') {
        inImport = false;
        continue;
      }
      // Still inside the import — drop this line too.
    }
  }
  return keep.join('\n');
}

// Strip JSX / MDX components from prose. Handles three cases in order:
//   1. Self-closing tags:       <Component ... />      → ""
//   2. Inline open/close pairs: <Tag>text</Tag>        → "text"
//   3. Multi-line open/close:   <Tag ...>\nbody\n</Tag> → "body"
//
// The regexes intentionally match only PascalCase tag names (starting with an
// uppercase letter). Lowercase HTML tags (<strong>, <em>, <div>) are preserved
// because both Dev.to and Medium render them natively. MDX component names
// follow the React convention of leading-capital.
//
// This is deliberately pragmatic rather than a full JSX parser — the MDX we
// cross-post is simple enough that two regex passes handle the real cases.
export function removeJsxComponents(content: string): string {
  let out = content;
  // Pass 1: self-closing tags. Non-greedy to avoid eating multiple tags
  // when they appear on the same line.
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?\/>/g, '');
  // Pass 2: same-line block tags with text content. Tolerates attributes on
  // the open tag but forbids nested `<` inside the body (the simple MDX we
  // emit never nests components inline).
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?>([^<]*)<\/\1>/g, '$2');
  // Pass 3: multi-line block tags. The `[\s\S]` character class matches
  // across newlines, and `*?` keeps the match non-greedy so back-to-back
  // components stay isolated. Tolerates one level; nested same-name tags
  // are not supported (and the MDX we emit never nests).
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?>([\s\S]*?)<\/\1>/g, '$2');
  return out;
}

// Rewrite relative asset references inside Markdown image / link syntax to
// absolute URLs under {baseUrl}/writing/{slug}/assets/…. Absolute URLs
// (http://, https://, schema-relative //, mailto:) are left alone. Anchor
// links (#section) are left alone.
export function resolveAssetUrls(
  content: string,
  slug: string,
  baseUrl: string,
): string {
  // Normalize base URL — strip a single trailing slash so we control the
  // join seam ourselves.
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  // Match either Markdown image `![alt](url "title"?)` or link `[text](url "title"?)`.
  // Capture the leading bang (if any), the bracketed content, and the URL
  // portion (up to the first whitespace or closing paren).
  return content.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (match, bang: string, text: string, url: string, title: string) => {
      // Skip absolute / protocol-relative / anchor / mailto / data: URIs.
      if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url)) {
        return match;
      }
      // Peel off a single leading `./` so we compare against `assets/...`.
      const stripped = url.replace(/^\.\//, '');
      if (!stripped.startsWith('assets/')) {
        return match;
      }
      const absolute = `${normalizedBase}/writing/${slug}/${stripped}`;
      return `${bang}[${text}](${absolute}${title})`;
    },
  );
}

// Fence tracking state. `null` when outside any fence; otherwise records the
// opening fence's marker char and length so the close test requires the
// same char with >= the opening length.
interface FenceState {
  marker: '`' | '~';
  length: number;
}

// Detect whether a line opens a fence. Must be called only when outside any
// existing fence.
function detectFenceOpen(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const run = match[1];
  return { marker: run[0] as '`' | '~', length: run.length };
}

// Detect whether a line closes the currently open fence. Same marker char,
// at least as many markers as opening, nothing but whitespace after the run.
function detectFenceClose(line: string, state: FenceState): boolean {
  const pattern = new RegExp(`^ {0,3}${state.marker === '`' ? '`' : '~'}{${state.length},}\\s*$`);
  return pattern.test(line);
}

// Collapse 3+ consecutive blank lines to exactly 2. Applied after JSX /
// import removal because those passes can leave runs of empty lines where
// components used to be.
function collapseBlankLines(content: string): string {
  return content.replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n');
}

// Top-level MDX → Markdown conversion. Wires helpers together behind a
// fence-aware state machine so code samples pass through untouched while
// prose sections receive import removal, JSX stripping, and URL resolution.
export function mdxToMarkdown(
  mdxContent: string,
  slug: string,
  baseUrl: string,
): string {
  const withoutFrontmatter = stripFrontmatter(mdxContent);
  const lines = withoutFrontmatter.split(/\r?\n/);

  // Partition lines into segments. Each segment is either inside-fence
  // (including its opening and closing fence lines) or outside-fence.
  type Segment = { inside: boolean; lines: string[] };
  const segments: Segment[] = [];
  let current: Segment = { inside: false, lines: [] };
  let fence: FenceState | null = null;
  for (const line of lines) {
    if (fence === null) {
      const open = detectFenceOpen(line);
      if (open) {
        // Flush the current outside segment and begin an inside segment
        // that starts with the opening fence line.
        if (current.lines.length > 0) segments.push(current);
        current = { inside: true, lines: [line] };
        fence = open;
      } else {
        current.lines.push(line);
      }
    } else {
      // Inside a fence — always append, and check for close.
      current.lines.push(line);
      if (detectFenceClose(line, fence)) {
        segments.push(current);
        current = { inside: false, lines: [] };
        fence = null;
      }
    }
  }
  if (current.lines.length > 0) segments.push(current);

  // Apply prose transforms to outside segments only.
  const transformed = segments.map((seg) => {
    if (seg.inside) return seg.lines.join('\n');
    const joined = seg.lines.join('\n');
    const imported = removeImports(joined);
    const dejsx = removeJsxComponents(imported);
    const withUrls = resolveAssetUrls(dejsx, slug, baseUrl);
    return withUrls;
  });

  const stitched = transformed.join('\n');
  return collapseBlankLines(stitched);
}
