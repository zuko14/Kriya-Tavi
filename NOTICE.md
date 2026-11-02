# Notices

Attribution for code adapted from other projects. Kriya's own license is in
`LICENSE`; this file only credits ported code.

## DeepSeek Harness

Parts of `runner/` adapt behaviour from DeepSeek Harness
(<https://github.com/deepseek-ai/deepseek-harness>), pinned at commit
`ce7073d51254c26cd63b22a60835b8f948deb447`, under the MIT License below.
No DeepSeek Harness package is a dependency of Kriya, and nothing from its
`vendor/` directory, assets or branding is included
(`docs/cloud-execution/DSH_COMPONENT_MAP.md` §3, §5; decisions CD-03, CD-22).

| Kriya file | Upstream path at `ce7073d` | What is adapted |
| --- | --- | --- |
| `runner/exec.ts` | `packages/subprocess/subprocess-local`, `packages/shell/bash-local`, `packages/spill/spill-local`, `packages/guard/timeout-policy` | Allow-listed child environment, process-group termination, bounded output with the full log on disk, per-command timeout (P1, P2, P6) |
| `runner/patch.ts` | `packages/fs/fs-patch` | The `*** Begin Patch` format and hunk application (P3) |
| `runner/files.ts` | `packages/fs/fs-observation-policy`, `packages/fs/tool-str-replace-editor` | Read before edit, refused when the file changed since; exact-replace edits (P4) |
| `runner/search.ts` | `packages/fs/tool-fs-search` | Match, line-length and time limits (P7) |
| `runner/changes.ts` | `packages/deliverables/workspace-changes` | The idea of reporting changed files against a base (P8); no code taken |

A later upstream change enters only as a reviewed port update that bumps
the commit here and in each file's header.

```text
MIT License

Copyright (c) 2026 DeepSeek

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
