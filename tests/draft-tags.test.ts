import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readExistingTags } from '../src/core/draft/tags.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('readExistingTags', () => {
  it('reads tags from MDX files in a directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tags-'));
    const postsDir = join(tempDir, 'content/posts');
    mkdirSync(postsDir, { recursive: true });

    writeFileSync(join(postsDir, 'post-a.mdx'), `---
title: Post A
tags:
  - typescript
  - benchmarks
published: true
---

Content A`);

    writeFileSync(join(postsDir, 'post-b.mdx'), `---
title: Post B
tags:
  - typescript
  - testing
published: true
---

Content B`);

    const tags = readExistingTags(tempDir, 'content/posts');
    expect(tags).toEqual(['benchmarks', 'testing', 'typescript']);
  });

  it('reads tags from subdirectory-based posts', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tags-'));
    const postDir = join(tempDir, 'content/posts/my-post');
    mkdirSync(postDir, { recursive: true });

    writeFileSync(join(postDir, 'index.mdx'), `---
title: My Post
tags:
  - devops
  - docker
published: true
---

Content`);

    const tags = readExistingTags(tempDir, 'content/posts');
    expect(tags).toEqual(['devops', 'docker']);
  });

  it('deduplicates tags', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tags-'));
    const postsDir = join(tempDir, 'content/posts');
    mkdirSync(postsDir, { recursive: true });

    writeFileSync(join(postsDir, 'a.mdx'), `---
tags:
  - rust
  - typescript
---
`);
    writeFileSync(join(postsDir, 'b.mdx'), `---
tags:
  - rust
  - go
---
`);

    const tags = readExistingTags(tempDir, 'content/posts');
    expect(tags).toEqual(['go', 'rust', 'typescript']);
  });

  it('returns empty array for missing directory', () => {
    const tags = readExistingTags('/nonexistent/path', 'content/posts');
    expect(tags).toEqual([]);
  });

  it('returns empty array for directory with no MDX files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tags-'));
    const postsDir = join(tempDir, 'content/posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(join(postsDir, 'readme.txt'), 'hello');

    const tags = readExistingTags(tempDir, 'content/posts');
    expect(tags).toEqual([]);
  });

  it('handles MDX files without tags field', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tags-'));
    const postsDir = join(tempDir, 'content/posts');
    mkdirSync(postsDir, { recursive: true });

    writeFileSync(join(postsDir, 'no-tags.mdx'), `---
title: No Tags
published: true
---

Content`);

    const tags = readExistingTags(tempDir, 'content/posts');
    expect(tags).toEqual([]);
  });
});
