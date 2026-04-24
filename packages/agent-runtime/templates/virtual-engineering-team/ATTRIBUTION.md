# Attribution

This template — **Virtual Engineering Team** — is a **verbatim port** of skill
files from [garrytan/gstack](https://github.com/garrytan/gstack), licensed
under the MIT License.

## What was ported

Every `.shogo/skills/gstack-<name>/SKILL.md` in this template is a
**byte-identical** copy of the corresponding `<name>/SKILL.md` file in the
upstream gstack repository. Only a small YAML frontmatter block is prepended
to each file to record the source URL, pinned commit SHA, license, role
mapping, and the port date. The prompt body itself is untouched.

- Upstream: https://github.com/garrytan/gstack
- Pinned commit: `9e244c0bed0fa0ac1e7473e4ca3e6d73944d5634`
- Port date: 2026-04-24
- Port script: `scripts/port-gstack.ts`
- Manifest:   `.shogo/skills/gstack-manifest.json`

To reproduce the port from a clean gstack checkout:

```bash
git clone https://github.com/garrytan/gstack.git /tmp/gstack
git -C /tmp/gstack checkout 9e244c0bed0fa0ac1e7473e4ca3e6d73944d5634
bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/port-gstack.ts --gstack /tmp/gstack
```

To detect drift from the current upstream:

```bash
bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/sync-gstack.ts --gstack /tmp/gstack
```

## What was NOT ported

This template does not reimplement gstack's binaries (`gstack-model-benchmark`,
`gstack-taste-update`, browser daemon, Chrome extension, Pretext HTML renderer)
or its Claude-Code installer. Those depend on Bun/Playwright/Chromium
environments that are outside the scope of this runtime. Any SKILL.md that
references those tools is still present verbatim, but the associated tooling
is unsupported in this template.

## License — garrytan/gstack

```
MIT License

Copyright (c) 2025 Garry Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
