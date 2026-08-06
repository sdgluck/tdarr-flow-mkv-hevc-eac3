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

| # | file | what must become true |
|---|---|---|
| 1 | `audio-selection.test.ts` | a 5.1 track survives a compatible stereo companion |
| 2 | `audio-selection.test.ts` | a file whose only audio is foreign does not come out silent |
| 3 | `robustness.test.ts` | an unreadable source exits cleanly, not as a crash |
| 5 | `robustness.test.ts` | encoders and Execute handle their own failure |
| 6 | `hygiene.test.ts` | one version of `runClassicTranscodePlugin` throughout |
| 7 | `hygiene.test.ts` | language cleanup costs no extra full file passes |
| 8 | `hygiene.test.ts` | CleanAudio and CleanSubs probe consistently |
| 9 | `hygiene.test.ts` | Reorder Streams carries no dead configuration |
| 11 | `hygiene.test.ts` | no two nodes share coordinates |

**Finding 4 was withdrawn.** It claimed the handle-3 edge from
`Compare File Size Ratio` to `Set Original File` was dead. That was based on
reading `compareFileSizeRatio` **v1.0.0**, which has two outputs. The flow uses
**v2.0.0**, which has three — handle 3 being "larger than upper bound". The
wiring is correct, and `tests/regression/audio-policy.test.ts` now locks that
in.

**Finding 2 was narrowed.** It originally claimed untagged audio would be
dropped, assuming `ffmpegCommandEnsureAudioStream` filters candidate sources by
language tag. Running the real plugin disproved that — untagged audio converts
fine, and those cases moved to the regression suite. What survives is a
foreign-language-only file, which reaches the audio block intact, gets no
English stream added, and then has its only track dropped. That contradicts the
main README's claim that such a file "keeps its foreign track".

Finding 10 (the README described this flow as TV-only when Film uses it too) is
documentation, not behaviour, so it has no test.

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
