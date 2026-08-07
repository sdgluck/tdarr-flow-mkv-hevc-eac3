import { describe, expect, it } from 'vitest';
import { Flow, probe } from 'tdarr-flow-test';

import { paths, run, runOn } from '../support/setup.ts';

/**
 * The flow this repo ships has since been fixed. The captured logs describe the
 * flow as it was, so the replay runs against a pinned copy - otherwise the
 * evidence that the harness matches real Tdarr would be thrown away the moment
 * the flow changed.
 */
const preGuards = Flow.fromFile(paths.preGuardFlow);

/**
 * The findings suite leans on the simulator being a faithful model of how Tdarr
 * walks this flow. That claim needs evidence, so this file replays jobs whose
 * real logs were captured and asserts the simulator reproduces what Tdarr
 * actually did.
 *
 * If these drift, treat every simulator-based finding as unproven until they
 * are fixed.
 */
describe('simulator fidelity against captured job logs', () => {
  it('reproduces the truncated MP4 failure on the pre-guard flow (Movie A)', () => {
    // Real job: ffprobe returned {}, so Tdarr recorded fileMedium "other",
    // no codecs, and videoStreamIndex -1. The mp4 was missing ~1.26 GiB and
    // its entire moov atom.
    const result = runOn(preGuards, probe.unreadableFile({ container: 'mp4', name: 'movie-a.mp4' }));

    // Both remux attempts ran, and both died at ffmpeg.
    expect(result.didVisit('Remux & Heal Container')).toBe(true);
    expect(result.didVisit('Force Remux')).toBe(true);
    expect(result.messages.filter((m) => m.includes('could not open the input'))).toHaveLength(2);

    // ForceRemuxMKV 2.0.0 must accept a non-MKV container. The 1.x version
    // declined anything that was not already Matroska, making it a no-op in
    // exactly the case that needed healing.
    expect(result.messages.some((m) => m.includes('Force remuxing mp4 to MKV'))).toBe(true);

    // The encoder declined, and CleanAudio refused to strip the last stream.
    expect(result.messages.some((m) => m.includes('not a video'))).toBe(true);
    expect(result.messages.some((m) => m.includes('would leave no audio'))).toBe(true);

    // ...and the job died at Begin Command, with no error handle to catch it.
    expect(result.halted?.kind).toBe('crash');
    expect(result.halted?.message).toContain('FFprobe');

    // The property that matters most: nothing was committed to the library.
    expect(result.replaced).toBe(false);
  });

  it('handles that same truncated MP4 cleanly on the current flow', () => {
    // The medium gate now catches it at the entry: no remux attempts, no
    // crash, and - the property that matters most - nothing committed.
    const result = run(probe.unreadableFile({ container: 'mp4', name: 'movie-a.mp4' }));

    expect(result.halted).toBeNull();
    expect(result.replaced).toBe(false);
    expect(result.didVisit('Remux & Heal Container')).toBe(false);
    expect(result.visited).toEqual(['Input File', 'Readable Video?']);
  });

  it('reproduces the SD .avi success (Show C S09E02)', () => {
    // Real job: mono 22.05 kHz mp3 in an AVI, no subtitles. Took the genpts
    // remux and the mono/96k ladder tier; 25.22 MB -> 21.78 MB.
    const result = run(
      probe.file({
        container: 'avi',
        name: 'show-c-s09e02.avi',
        size: 25_220_000,
        streams: [
          probe.video({ codec: 'mpeg4' }),
          probe.audio({ codec: 'mp3', channels: 1, sampleRate: 22_050 }),
        ],
      }),
    );

    expect(result.halted).toBeNull();

    // Neither surround nor stereo, so it takes the mono tier and stays mono.
    const route = result.path
      .filter((entry) => entry.plugin === 'checkStreamProperty')
      .map((entry) => `${entry.name}=${entry.handle}`);
    expect(route).toEqual(['Surround Present?=2', 'Stereo Present?=2']);

    // Ends as MKV with exactly one E-AC3 mono track, and commits.
    expect(result.file.container).toBe('mkv');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('eac3');
    expect(result.audio[0]?.channels).toBe(1);
    expect(result.replaced).toBe(true);
  });
});
