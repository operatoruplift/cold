# Third-party notices

## dialer

`src/domains/twenty/schema/applySchema.ts` and
`src/domains/twenty/schema/types.ts` are adapted from
[dialer](https://github.com/matthewdonsemail-lab/dialer)
(`backend/src/lib/twenty/schema/`). The Twenty keyset paging in
`src/domains/twenty/client/` follows the approach dialer documents.
dialer is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Cold Dialer Contributors

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

The call scripts `cold call sync` writes use dialer's `agencyScripts` data
format so they appear in its script viewer; that is interoperability, not
copied code.

## Inter

The site and the app use [Inter](https://rsms.me/inter/) by Rasmus Andersson,
served from the [@fontsource-variable/inter](https://fontsource.org/fonts/inter)
package under the SIL Open Font License 1.1. The wordmark in
`public/brand/cold-logo*.svg` is set in Inter Display Bold and converted to
outlines. The license is in the package
(`node_modules/@fontsource-variable/inter/LICENSE`).

## ListeningKit

The site's motion (cloud banks drifting at three depths, a pinned step section
with flipping copy, pop-in icons) takes after the
[ListeningKit](https://github.com/matthewdonsemail-lab/log) landing page (MIT,
Copyright (c) 2026 ListeningKit Contributors). No code was copied; the
patterns were rewritten for COLD.

