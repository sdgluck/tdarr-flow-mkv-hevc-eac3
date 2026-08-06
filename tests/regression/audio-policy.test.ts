import { describe, expect, it } from 'vitest';
import { probe } from 'tdarr-flow-test';

import { run } from '../support/setup.ts';

/**
 * Audio behaviours verified against REAL stock plugin source. These started as
 * suspected defects and turned out to be correct, so they are locked in here
 * to stop a fix for a neighbouring finding from breaking them.
 */
describe('audio policy', () => {
  it('converts untagged audio rather than dropping it', () => {
    // Originally suspected of producing a silent file, on the assumption that
    // Ensure filters candidate sources by language tag. The real plugin does
    // not, and converts the untagged stream.
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'dts', channels: 6, language: null }),
        ],
      }),
    );

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('eac3');
    expect(result.audio[0]?.channels).toBe(6);
  });

  it('converts untagged stereo FLAC at the stereo tier', () => {
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'flac', channels: 2, language: null }),
        ],
      }),
    );

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.channels).toBe(2);
  });

  it('passes through audio that already direct-plays, without re-encoding', () => {
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'hevc' }),
          probe.audio({ codec: 'eac3', channels: 6, language: 'eng' }),
        ],
      }),
    );

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('eac3');
  });

  it('discards an oversized transcode via Set Original File', () => {
    // compareFileSizeRatio v2.0.0 has three outputs, handle 3 being "larger
    // than upper bound". The flow wires it correctly.
    const result = run(
      probe.file({
        container: 'mkv',
        size: 1_000_000,
        streams: [probe.video({ codec: 'h264' }), probe.audio({ codec: 'eac3', channels: 6 })],
      }),
      { transcodeRatio: 1.3 },
    );

    expect(result.didVisit('Set Original File')).toBe(true);
  });

  it('keeps a transcode that saved space', () => {
    const result = run(
      probe.file({
        container: 'mkv',
        size: 1_000_000,
        streams: [probe.video({ codec: 'h264' }), probe.audio({ codec: 'eac3', channels: 6 })],
      }),
      { transcodeRatio: 0.6 },
    );

    expect(result.didVisit('Set Original File')).toBe(false);
    expect(result.video[0]?.codec_name).toBe('hevc');
  });
});
