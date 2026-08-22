# Tests

Built on [`tdarr-flow-test`](../../tdarr-test), linked from `../tdarr-test`.

```sh
pnpm test            # regression suite - MUST be green
pnpm test:findings   # findings suite   - red until each defect is fixed
pnpm typecheck
pnpm lint:flow       # tdarr-test lint, pretty printed
```

There is no bespoke tooling in this repo. Everything generic lives in the
package; this directory holds only scenarios specific to the Transcode
Pipeline flow.

## Two suites, on purpose

**`tests/regression/`** passes today and must keep passing. It locks in the
behaviours that were expensive to get right — the `+genpts` input arg, the
SDH/commentary split, `not_equals` on the audio drop, the largest-first channel
ladder, the `Is MKV?` gates, CleanAudio's refusal to strip the last stream —
plus behaviours that were *suspected* defects and turned out fine, so a fix
elsewhere cannot quietly break them.

**`tests/findings/`** asserts *correct* behaviour, so it is **red while the
defects are unfixed**. Each test goes green when, and only when, its defect is
actually fixed. Do not "fix" one by changing the assertion.

## Findings currently reproduced

None. Every finding raised in the review has been fixed and its assertions moved
into `tests/regression`, which is where they belong once they pass.
`tests/findings/` does not exist; `vitest.findings.config.ts` passes with no
tests. Add a `tests/findings/*.test.ts` when the next defect turns up.

## How much these prove

The harness executes the **real** stock plugins from vendored Tdarr source, not
models of them — `tdarr-test plugins` reports which commit. Only nodes that
shell out to ffmpeg/mkvpropedit or move files are still modelled, and their
routing logic is reproduced from the real source.

`tests/regression/fidelity.test.ts` is load-bearing. It replays two jobs whose
real Tdarr logs were captured — the truncated *Movie A* MP4 and the
successful *Show C S09E02* AVI — and asserts the simulator reproduces what
Tdarr actually did. **If those drift, treat every simulator-based finding as
unproven until they are fixed.**

Nothing here runs ffmpeg. Anything about ffmpeg's actual output needs a real
file through a real server.

## Adding a scenario

```ts
import { probe } from 'tdarr-flow-test';
import { run } from '../support/setup.ts';

const result = run(probe.file({
  container: 'mkv',
  streams: [probe.video({ codec: 'h264' }), probe.audio({ codec: 'dts', channels: 6 })],
}));

expect(result.audio[0]?.codec_name).toBe('eac3');
expect(result.replaced).toBe(true);
```

`result` carries `file`, `audio` / `video` / `subtitles`, `replaced`, `halted`,
`visited`, `path` and `messages`. Reference nodes through `nodes` in
`support/setup.ts` rather than by raw id, so a rename produces one clear
failure instead of several confusing ones.

Prefer asserting on `result.path` over log text — log wording belongs to the
plugin, not to us, and changes when Tdarr updates.
