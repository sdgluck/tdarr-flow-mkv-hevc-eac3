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

/**
 * A track flagged `default` that ffmpeg cloned from the source, and a bitrate
 * larger than the source ever carried. Both come from `Ensure Audio Stream`
 * deep-copying the stream it converts from, and both are Normalise's to fix.
 */
const withDefault = (options: Parameters<typeof probe.audio>[0]) => {
  const stream = probe.audio(options);
  return { ...stream, disposition: { ...stream.disposition, default: 1 } };
};

const defaults = (result: ReturnType<typeof run>) =>
  result.audio.map((s) => Number(s.disposition?.default ?? 0));

describe('audio policy: default track flag', () => {
  it('leaves exactly one default audio track', () => {
    // Two Ensure nodes both clone the source, so both generated tracks inherit
    // its default flag. Two defaults is a malformed MKV and players disagree
    // about what to do with it - observed as a refused transcode.
    const result = run(probe.file({
      streams: [probe.video({ codec: 'hevc' }), withDefault({ codec: 'aac', channels: 6 })],
    }));

    expect(result.audio).toHaveLength(2);
    expect(defaults(result)).toEqual([1, 0]);
  });

  it('puts the default flag on the surround track, not the stereo mate', () => {
    const result = run(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        probe.audio({ codec: 'dts', channels: 6 }),
        withDefault({ codec: 'aac', channels: 2 }),
      ],
    }));

    expect(result.audio[0]?.channels).toBe(6);
    expect(defaults(result)).toEqual([1, 0]);
  });

  it('flags the only track as default when there is just one', () => {
    const result = run(probe.file({
      streams: [probe.video({ codec: 'hevc' }), probe.audio({ codec: 'aac', channels: 2 })],
    }));

    expect(defaults(result)).toEqual([1]);
  });

  it('does not rewrite a file whose flags are already right', () => {
    // Otherwise every pass over an already-correct library rewrites every file.
    const result = run(probe.file({
      container: 'mkv',
      streams: [
        probe.video({ codec: 'hevc' }),
        withDefault({ codec: 'eac3', channels: 6 }),
        probe.audio({ codec: 'eac3', channels: 2 }),
      ],
    }));

    expect(defaults(result)).toEqual([1, 0]);
    expect(
      result.messages.some((m) => /No need to process file/.test(m)),
      'a compliant file was rewritten',
    ).toBe(true);
  });
});

describe('audio policy: bitrate cap', () => {
  const bitrates = (source: ReturnType<typeof probe.audio>) =>
    run(probe.file({ streams: [probe.video({ codec: 'hevc' }), source] }))
      .audio.map((s) => Number(s.bit_rate ?? 0) / 1000);

  it('caps a track at what its source actually carried', () => {
    // The Show E case: 197kbps of HE-AAC re-encoded to 384k + 192k grew a 633MB
    // file to 801MB, spending 2.9x the bitrate to carry less information.
    expect(bitrates(probe.audio({ codec: 'aac', channels: 6, bitRate: 196_900 })))
      .toEqual([192, 192]);
  });

  it('reads the source bitrate from the BPS tag when ffprobe omits bit_rate', () => {
    // Matroska is the common case and it rarely fills bit_rate in.
    const source = probe.audio({ codec: 'aac', channels: 6 });
    const tagged = { ...source, tags: { ...source.tags, BPS: '196900' } };
    expect(bitrates(tagged)).toEqual([192, 192]);
  });

  it('leaves the configured bitrate alone when the source is fatter', () => {
    expect(bitrates(probe.audio({ codec: 'dts', channels: 6, bitRate: 1_500_000 })))
      .toEqual([384, 192]);
  });

  it('leaves the configured bitrate alone when the source bitrate is unknown', () => {
    // No bit_rate and no BPS tag. Guessing low would quietly degrade the audio.
    expect(bitrates(probe.audio({ codec: 'dts', channels: 6 }))).toEqual([384, 192]);
  });

  it('never caps below the floor, however thin the source', () => {
    // A 48kbps source is not a reason to encode 5.1 E-AC3 at 32k.
    expect(bitrates(probe.audio({ codec: 'aac', channels: 6, bitRate: 48_000 })))
      .toEqual([128, 128]);
  });
});

/**
 * The transcode output guard. This used to be one-sided: `greaterThan: 0` meant
 * the "smaller than lower bound" output could never fire, and it was wired to
 * accept anyway, so an encoder that exited 0 having written a truncated file
 * overwrote the source. Confirmed at the time: a 0.1% output replaced the
 * library file.
 */
describe('transcode output guard', () => {
  const h264 = () => probe.file({
    streams: [probe.video({ codec: 'h264' }), probe.audio({ codec: 'eac3', channels: 6 })],
  });

  it.each([0.001, 0.01, 0.05, 0.19])('discards a runt output at ratio %s', (ratio) => {
    expect(run(h264(), { transcodeRatio: ratio }).didVisit('Set Original File')).toBe(true);
  });

  it.each([0.25, 0.5, 0.7, 0.99])('accepts a genuine saving at ratio %s', (ratio) => {
    expect(run(h264(), { transcodeRatio: ratio }).didVisit('Set Original File')).toBe(false);
  });

  it('still discards an output that grew', () => {
    expect(run(h264(), { transcodeRatio: 1.5 }).didVisit('Set Original File')).toBe(true);
  });
});

/**
 * Language. The tie-breakers below language - codec, channels, bitrate - are
 * all equal across the three stereo E-AC3 tracks of a typical multi-language
 * web-rip, so whichever came first in the file used to win. Show D
 * S01E01 was spa/por/eng in that order and came out Spanish.
 */
describe('audio policy: language', () => {
  const languages = (streams: ReturnType<typeof probe.audio>[]) =>
    run(probe.file({ streams: [probe.video({ codec: 'h264' }), ...streams] }))
      .audio.map((s) => s.tags?.language);

  it('keeps English when every other property ties', () => {
    expect(languages([
      probe.audio({ codec: 'eac3', channels: 2, language: 'spa' }),
      probe.audio({ codec: 'eac3', channels: 2, language: 'por' }),
      probe.audio({ codec: 'eac3', channels: 2, language: 'eng' }),
    ])).toEqual(['eng']);
  });

  it('prefers English over a foreign track in the target codec', () => {
    expect(languages([
      probe.audio({ codec: 'eac3', channels: 2, language: 'spa' }),
      probe.audio({ codec: 'aac', channels: 2, language: 'eng' }),
    ])).toEqual(['eng']);
  });

  it('prefers an untagged track over a foreign one', () => {
    // Untagged is far more often the main track than a foreign one; this is the
    // same judgement CleanTracks makes when it declines to remove them.
    expect(languages([
      probe.audio({ codec: 'eac3', channels: 2, language: 'spa' }),
      probe.audio({ codec: 'eac3', channels: 2, language: null }),
    ])).toEqual([undefined]);
  });

  it('picks English in each channel tier independently', () => {
    const result = run(probe.file({
      streams: [
        probe.video({ codec: 'h264' }),
        probe.audio({ codec: 'eac3', channels: 6, language: 'spa' }),
        probe.audio({ codec: 'eac3', channels: 6, language: 'eng' }),
        probe.audio({ codec: 'eac3', channels: 2, language: 'spa' }),
        probe.audio({ codec: 'eac3', channels: 2, language: 'eng' }),
      ],
    })).audio;

    expect(result.map((s) => `${s.tags?.language}/${s.channels}ch`))
      .toEqual(['eng/6ch', 'eng/2ch']);
  });
});
