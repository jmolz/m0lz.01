# Stack Loops Hub/Deploy Proof

Feature plan: `.codex/plans/distribution-copy-and-linkedin-image-quality.md`

Generated: 2026-05-19T17:02:32Z
Refreshed during evaluate/review rerun: 2026-05-19T18:15:22Z

This file records source-bounded evidence for contract criterion 11: the corrected Stack Loops distribution artifacts are on the hub repo `main`, and the pushed commit deployed.

## Evaluate Cycle Validation Proof

Command:

```bash
npx tsc --noEmit
npm test
npm run build
git diff --check
```

Output:

```text
npx tsc --noEmit: PASS
npm test: PASS, 79 test files, 1136 tests
npm run build: PASS
git diff --check: PASS
```

## Hub Repo State

Command:

```bash
git -C /Users/jacobmolz/code/m0lz.00 log -1 --format='%H%n%s%n%cI'
git -C /Users/jacobmolz/code/m0lz.00 rev-list --left-right --count main...origin/main
```

Output:

```text
ec64472bf00e7b6334cae23d5037da62073d2378
chore(distribution): m0lz-02-stack-loops (#6)
2026-05-19T12:35:21-04:00
0	0
```

## Manifest Proof

Command:

```bash
jq '.prompt, .image, .image_provider, .image_model, .image_quality, .image_mode' \
  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/manifest.json
```

Output:

```json
null
{
  "path": "assets/linkedin-feed.png",
  "sha256": "a9233963b5cceee50abfd8d0d1a44292fb3553680f133fa248558505c9f080e0",
  "width": 1200,
  "height": 1200,
  "bytes": 75004
}
"local-card"
"local-card-v1"
"deterministic"
"local-card"
```

## Artifact Proof

Command:

```bash
file /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/assets/linkedin-feed.png
shasum -a 256 \
  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/assets/linkedin-feed.png \
  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/linkedin.md \
  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/hackernews.md \
  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/substack-paste.md
```

Output:

```text
/Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/assets/linkedin-feed.png: PNG image data, 1200 x 1200, 8-bit/color RGBA, non-interlaced
a9233963b5cceee50abfd8d0d1a44292fb3553680f133fa248558505c9f080e0  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/assets/linkedin-feed.png
e985c716e2d6ab6c7934ee22f015b1318706fb039ccc1d2de89150343e64371b  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/linkedin.md
1d08c159bc341714974c8f9d39d9a920c661cc1dc0c66988deb8e724150e6a7f  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/hackernews.md
93d4b5836b0e2a67b20fdac1c154c113ce6407dc1471ef4d8dcd6af12686805c  /Users/jacobmolz/code/m0lz.00/content/posts/m0lz-02-stack-loops/distribution/substack-paste.md
```

## Deploy Proof

Command:

```bash
gh api repos/jmolz/m0lz.00/commits/ec64472bf00e7b6334cae23d5037da62073d2378/status \
  --jq '{state: .state, statuses: [.statuses[] | {context, state, target_url, description}]}'
curl -I https://m0lz.dev/writing/m0lz-02-stack-loops/assets/linkedin-feed.png
```

Output:

```json
{"state":"success","statuses":[{"context":"Vercel","description":"Deployment has completed","state":"success","target_url":"https://vercel.com/molz/m0lz.00/AMEsMK9zUs2zNaDvVg3XsdSDCEpY"}]}
```

```text
HTTP/2 200
content-disposition: inline; filename="linkedin-feed.png"
content-type: image/png
date: Tue, 19 May 2026 18:15:22 GMT
last-modified: Tue, 19 May 2026 16:36:19 GMT
server: Vercel
x-matched-path: /writing/m0lz-02-stack-loops/assets/linkedin-feed.png
x-vercel-cache: HIT
content-length: 75004
```
