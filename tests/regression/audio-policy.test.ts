import { describe, expect, it } from 'vitest';
import { probe } from 'tdarr-flow-test';

import { run } from '../support/setup.ts';

/**
 * The audio policy, verified against real stock plugin source.
 *
 * Every file ends with at most two English E-AC3 tracks: one surround (4+
 * channels) when the source has surround, and one stereo/mono mate. Surround
 * comes first, because players default to the first audio track.
 */
const layout = (streams: ReturnType<typeof probe.audio>[]) =>
  run(probe.file({ streams: [probe.video({ codec: 'h264' }), ...streams] }))
    .audio.map((s) => `${s.codec_name}/${s.channels}ch`);

describe('audio policy: surround and stereo', () => {
  it('keeps both when the source has surround and stereo', () => {
    // The case that used to silently discard the surround track, because some
    // stream direct-played and the whole conversion was skipped.
    expect(layout([
      probe.audio({ codec: 'dts', channels: 6 }),
      probe.audio({ codec: 'aac', channels: 2 }),
    ])).toEqual(['eac3/6ch', 'eac3/2ch']);
  });

  it('generates a stereo mate when the source is surround only', () => {
    expect(layout([probe.audio({ codec: 'dts', channels: 6 })]))
      .toEqual(['eac3/6ch', 'eac3/2ch']);
  });

  it('downmixes 7.1 to 5.1 and still adds a stereo mate', () => {
    expect(layout([probe.audio({ codec: 'truehd', channels: 8 })]))
      .toEqual(['eac3/6ch', 'eac3/2ch']);
  });

  it('treats 4 channels as surround, keeping it ahead of the stereo mate', () => {
    // Reorder Streams cannot order this - its channel map only knows 8/6/2/1 -
    // so the local plugin places it.
    expect(layout([probe.audio({ codec: 'dts', channels: 4 })]))
      .toEqual(['eac3/4ch', 'eac3/2ch']);
  });

  it('produces a single stereo track when the source has no surround', () => {
    expect(layout([probe.audio({ codec: 'aac', channels: 2 })])).toEqual(['eac3/2ch']);
  });

  it('keeps mono as mono rather than upmixing it', () => {
    expect(layout([probe.audio({ codec: 'mp3', channels: 1 })])).toEqual(['eac3/1ch']);
  });

  it('takes the stereo tier when a file has both mono and stereo', () => {
    expect(layout([
      probe.audio({ codec: 'mp3', channels: 1 }),
      probe.audio({ codec: 'aac', channels: 2 }),
    ])).toEqual(['eac3/2ch']);
  });

  it('does not leave the original stereo track beside the generated one', () => {
    // Ensure only adds. Without Normalise Audio Tracks this file would come out
    // with three audio streams.
    expect(layout([
      probe.audio({ codec: 'dts', channels: 6 }),
      probe.audio({ codec: 'aac', channels: 2 }),
    ])).toHaveLength(2);
  });

  it('converts untagged audio rather than dropping it', () => {
    // Ensure tries the configured language, then falls back to 'und'.
    expect(layout([probe.audio({ codec: 'dts', channels: 6, language: null })]))
      .toEqual(['eac3/6ch', 'eac3/2ch']);
  });
});

describe('audio policy: ffmpeg argument safety', () => {
  it('keeps 5.1 when the surround track has to be re-encoded, not copied', () => {
    // The case that cost a real 5.1 track. Both Ensure nodes encode, so both
    // emit "-ac". Unqualified, ffmpeg applies the LAST one to every stream and
    // silently produces two stereo tracks while reporting success.
    expect(layout([probe.audio({ codec: 'ac3', channels: 6 })]))
      .toEqual(['eac3/6ch', 'eac3/2ch']);
  });

  it('qualifies -ac per stream so the two encodes cannot collide', () => {
    const result = run(probe.file({
      streams: [probe.video({ codec: 'hevc' }), probe.audio({ codec: 'ac3', channels: 6 })],
    }));

    const rewrites = result.messages.filter((m) => m.includes('Rewrote args'));
    expect(rewrites.length, 'Normalise Audio Tracks did not qualify the args').toBeGreaterThan(0);
    for (const line of rewrites) {
      expect(line).toContain('-ac:{outputIndex}');
    }
  });

  it('drops the args a second Ensure inherits from the first', () => {
    // Ensure clones the highest-channel stream to build a new one, so the
    // stereo stream arrives carrying the surround stream's args too.
    const result = run(probe.file({
      streams: [probe.video({ codec: 'hevc' }), probe.audio({ codec: 'ac3', channels: 6 })],
    }));

    const stereoRewrite = result.messages.find((m) => m.includes('-> ') && m.includes('192k'));
    expect(stereoRewrite).toBeDefined();
    // The rewritten half must mention 384k nowhere - that was the inherited arg.
    expect(stereoRewrite?.split('-> ')[1]).not.toContain('384k');
  });
});

describe('audio policy: idempotency', () => {
  it('re-encodes nothing on a file that already matches the policy', () => {
    // The flow runs repeatedly over the library. If this regresses, every pass
    // re-encodes everything.
    const result = run(probe.file({
      container: 'mkv',
      streams: [
        probe.video({ codec: 'hevc' }),
        probe.audio({ codec: 'eac3', channels: 6 }),
        probe.audio({ codec: 'eac3', channels: 2 }),
      ],
    }));

    expect(result.audio.map((s) => `${s.codec_name}/${s.channels}ch`))
      .toEqual(['eac3/6ch', 'eac3/2ch']);
    expect(
      result.messages.some((m) => /Adding eng stream/.test(m)),
      'a compliant file was re-encoded',
    ).toBe(false);
  });
});

describe('audio policy: never silent', () => {
  it('keeps a foreign track when there is no English source to convert', () => {
    // Ensure filters by language and finds no candidate, so nothing is
    // generated. Better an untouched foreign track than a silent file.
    expect(layout([probe.audio({ codec: 'dts', channels: 6, language: 'fre' })]))
      .toEqual(['dts/6ch']);
  });

  it('survives an audio-only file whose only track is foreign', () => {
    const result = run(probe.file({
      container: 'mkv',
      streams: [probe.audio({ codec: 'dts', channels: 6, language: 'fre' })],
    }));
    expect(result.halted, `flow died: ${result.halted?.message ?? ''}`).toBeNull();
    expect(result.audio.length).toBeGreaterThanOrEqual(1);
  });
});

describe('video policy', () => {
  it('discards an oversized transcode via Set Original File', () => {
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
