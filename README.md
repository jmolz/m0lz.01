<p align="center">
  <img src="branch-mark.svg" width="48" height="48" alt="m0lz.01 branch mark — blog-agent variant">
</p>

<h1 align="center">m0lz.01</h1>

<p align="center">
  <strong>Automated content publishing agent</strong><br>
  Commits MDX posts to <a href="https://github.com/jmolz/m0lz.00">m0lz.00</a>, cross-posts to Medium and Dev.to.
</p>

---

## Overview

m0lz.01 is a publishing agent for [m0lz.dev](https://m0lz.dev). It generates technical blog posts, commits them as MDX files to the m0lz.00 repo, and cross-posts to external platforms. This repo renders nothing — it publishes.

## Architecture

```
m0lz.01 (this repo)
  ├── Generate MDX post from research/outline
  ├── Commit to m0lz.00/content/posts/{slug}/index.mdx
  ├── Push to main → Vercel auto-deploys m0lz.dev
  └── Cross-post to Medium and Dev.to (update frontmatter URLs)
```

## Status

Under development.

## License

MIT
