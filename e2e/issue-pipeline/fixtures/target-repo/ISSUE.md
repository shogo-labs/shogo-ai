# `slugify()` leaves a trailing dash for titles ending in punctuation

`slugify("Great Deal!")` returns `"great-deal-"` instead of `"great-deal"`.
Any input whose last character isn't alphanumeric gets a stray trailing
hyphen, because the separator collapse only strips it from the front:

```ts
slugify("Great Deal!")   // -> "great-deal-"   (want "great-deal")
slugify("Wait... what?") // -> "wait-what-"    (want "wait-what")
slugify("Hello World")   // -> "hello-world"   (unaffected — no trailing punctuation)
```

This is used to build public URLs, so the trailing dash ends up in links we
publish (`/posts/great-deal-` instead of `/posts/great-deal`).

Repro:

```bash
bun -e "import { slugify } from './src/slugify'; console.log(slugify('Great Deal!'))"
```

This is the seed issue for the `e2e/issue-pipeline` eval ladder — see
`docs/issue-pipeline/PLAN.md` Phase 4, level L0. The harness posts this file
as a GitHub issue body on the fixture repo; the pipeline is expected to
reproduce it, propose options, plan, implement a fix plus a regression test
that fails on `main` and passes on the fix branch, get it reviewed, and open
a PR — without touching `src/slugify.test.ts` (see the comment at the top of
that file).
