import { describe, expect, it } from 'vitest';
import { loadClassicPlugin, probe } from 'tdarr-flow-test';
import type { FfProbeStream, TdarrFile } from 'tdarr-flow-test';

import { paths, run } from '../support/setup.ts';

/**
 * Foreign films keep their original-language audio.
 *
 * Movie B shipped fre (default) + eng 5.1, each with a
 * "Descriptive" twin, and came out English-only: CleanTracks kept only `eng`
 * whenever an English track existed at all.
 *
 * The original language is what the release itself declares - the `original`
 * disposition, else the single default audio track. Track order alone is no
 * signal (Show D S01E01 was spa/por/eng, English the real original), so a file
 * flagging nothing keeps the English-only behaviour the other suites pin.
 */
const flagged = (stream: FfProbeStream, flags: Record<string, number>): FfProbeStream => ({
  ...stream,
  disposition: { ...stream.disposition, ...flags },
});

const movieB = () => probe.file({
  container: 'mkv',
  streams: [
    probe.video({ codec: 'h264' }),
    flagged(probe.audio({ codec: 'eac3', channels: 6, language: 'fre' }), { default: 1 }),
    probe.audio({ codec: 'eac3', channels: 6, language: 'eng' }),
    probe.audio({ codec: 'eac3', channels: 6, language: 'fre', title: 'Descriptive' }),
    probe.audio({ codec: 'eac3', channels: 6, language: 'eng', title: 'Descriptive' }),
    probe.subtitle({ language: 'fre', title: 'CC' }),
    probe.subtitle({ language: 'eng', title: 'Forced', forced: true }),
    probe.subtitle({ language: 'eng' }),
    probe.subtitle({ language: 'eng', title: 'SDH' }),
  ],
});

const layout = (file: TdarrFile) => run(file).audio
  .map((s) => `${s.tags?.language}/${s.codec_name}/${s.channels}ch${s.disposition?.default ? '*' : ''}`);

describe('original language: flow', () => {
  it('keeps the original surround and stereo first, then the English pair', () => {
    expect(layout(movieB())).toEqual([
      'fre/eac3/6ch*',
      'fre/eac3/2ch',
      'eng/eac3/6ch',
      'eng/eac3/2ch',
    ]);
  });

  it('still drops audio description and keeps one English subtitle', () => {
    const result = run(movieB());
    expect(result.audio.some((s) => /descri/i.test(s.tags?.title ?? ''))).toBe(false);
    expect(result.subtitles.map((s) => `${s.tags?.language}/${s.tags?.title ?? ''}`))
      .toEqual(['eng/']);
  });

  it('rewrites nothing on a second pass', () => {
    // Every library pass re-runs the flow; this must settle after one.
    const first = run(movieB());
    const second = run(probe.file({ container: 'mkv', streams: first.file.streams }));
    expect(second.audio.map((s) => `${s.tags?.language}/${s.channels}ch`))
      .toEqual(['fre/6ch', 'fre/2ch', 'eng/6ch', 'eng/2ch']);
    expect(second.messages.filter((m) => /Encoding|Reordered|Removing audio/.test(m))).toEqual([]);
  });

  it('converts a non-E-AC3 original and downmixes 7.1 to 5.1', () => {
    expect(layout(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        flagged(probe.audio({ codec: 'truehd', channels: 8, language: 'jpn' }), { default: 1 }),
        probe.audio({ codec: 'ac3', channels: 6, language: 'eng' }),
      ],
    }))).toEqual(['jpn/eac3/6ch*', 'jpn/eac3/2ch', 'eng/eac3/6ch', 'eng/eac3/2ch']);
  });

  it('gives an original-only film the full layout', () => {
    expect(layout(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        flagged(probe.audio({ codec: 'dts', channels: 6, language: 'kor' }), { default: 1 }),
      ],
    }))).toEqual(['kor/eac3/6ch*', 'kor/eac3/2ch']);
  });

  it('honours the original disposition over the default flag', () => {
    expect(layout(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        flagged(probe.audio({ codec: 'eac3', channels: 2, language: 'eng' }), { default: 1 }),
        flagged(probe.audio({ codec: 'eac3', channels: 2, language: 'ita' }), { original: 1 }),
      ],
    }))).toEqual(['ita/eac3/2ch*', 'eng/eac3/2ch']);
  });

  it('changes nothing for an English original', () => {
    expect(layout(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        flagged(probe.audio({ codec: 'eac3', channels: 6, language: 'eng' }), { default: 1 }),
        probe.audio({ codec: 'eac3', channels: 6, language: 'fre' }),
      ],
    }))).toEqual(['eng/eac3/6ch*', 'eng/eac3/2ch']);
  });

  it('keeps English only when the release flags nothing', () => {
    expect(layout(probe.file({
      streams: [
        probe.video({ codec: 'hevc' }),
        probe.audio({ codec: 'eac3', channels: 2, language: 'spa' }),
        probe.audio({ codec: 'eac3', channels: 2, language: 'eng' }),
      ],
    }))).toEqual(['eng/eac3/2ch*']);
  });
});

describe('original language: CleanTracks', () => {
  const call = (file: TdarrFile, otherArguments: Record<string, unknown> = {}) =>
    loadClassicPlugin('Tdarr_Plugin_bsh1_CleanTracks', { dir: paths.classicPluginDir })
      .plugin(file, {}, { tag_language: 'eng', remove_commentary: 'true', remove_sdh: 'false' }, otherArguments);

  it('ignores two tracks that both claim default', () => {
    const file = probe.file({
      streams: [
        probe.video(),
        flagged(probe.audio({ language: 'fre' }), { default: 1 }),
        flagged(probe.audio({ language: 'eng' }), { default: 1 }),
      ],
    });
    expect(call(file).preset).toContain('-map -0:1');
  });

  it('judges by the library file, not the working file', () => {
    // The HEVC encode can leave the first track flagged default where the
    // release flagged none; only the file as downloaded tells the truth.
    const working = probe.file({
      streams: [
        probe.video(),
        flagged(probe.audio({ language: 'spa' }), { default: 1 }),
        probe.audio({ language: 'eng' }),
      ],
    });
    const original = probe.file({
      streams: [probe.video(), probe.audio({ language: 'spa' }), probe.audio({ language: 'eng' })],
    });
    expect(call(working, { originalLibraryFile: original }).preset).toContain('-map -0:1');
    expect(call(working).processFile).toBe(false);
  });
});
