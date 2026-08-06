import { describe, expect, it } from 'vitest';
import { probe } from 'tdarr-flow-test';

import { run } from '../support/setup.ts';

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
  it('reproduces the truncated MP4 failure (Movie A)', () => {
    // Real job: ffprobe returned {}, so Tdarr recorded fileMedium "other",
    // no codecs, and videoStreamIndex -1. The mp4 was missing ~1.26 GiB and
    // its entire moov atom.
    const result = run(probe.unreadableFile({ container: 'mp4', name: 'movie-a.mp4' }));

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

    // The ladder must walk 6 -> 8 -> 2 -> 1 and land on mono. Asserted on the
    // path rather than on log text, which belongs to the plugin, not to us.
    const ladder = result.path
      .filter((entry) => entry.plugin === 'checkChannelCount')
      .map((entry) => `${entry.name}=${entry.handle}`);
    expect(ladder).toEqual(['6ch?=2', '8ch?=2', '2ch?=2', '1ch?=1']);

    // The 96k tier asks for 6 channels and relies on the plugin clamping to
    // what the source actually has. Confirmed against real plugin source.
    expect(result.messages.some((m) => m.includes('higher than the highest available'))).toBe(true);

    // Ends as MKV with exactly one E-AC3 mono track, and commits.
    expect(result.file.container).toBe('mkv');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('eac3');
    expect(result.audio[0]?.channels).toBe(1);
    expect(result.replaced).toBe(true);
  });
});
