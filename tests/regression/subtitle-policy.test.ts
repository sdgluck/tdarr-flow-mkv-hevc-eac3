import { describe, expect, it } from 'vitest';
import { probe } from 'tdarr-flow-test';

import { run } from '../support/setup.ts';

/**
 * The subtitle policy, end to end through the real flow.
 *
 * Every file leaves the flow with at most ONE subtitle track. Two English text
 * tracks are indistinguishable to a player whenever the source flags neither -
 * Show B S03E08 labelled its SDH track in the title only, so both came out as
 * plain eng/subrip - and Plex's subtitle selector then matched both. Its SRT
 * output cannot represent that:
 *
 *   [srt] SRT supports only a single subtitles stream
 *   [TranscodeOutputStream] Session appears to have died from under us
 *
 * Disambiguating the two tracks would have fixed that one selector. Keeping one
 * makes the whole failure mode unreachable.
 */
const subtitles = (streams: ReturnType<typeof probe.subtitle>[]) =>
  run(probe.file({
    streams: [probe.video({ codec: 'hevc' }), probe.audio({ codec: 'eac3', channels: 6 }), ...streams],
  })).subtitles;

describe('subtitle policy: at most one track', () => {
  it('keeps one when the source has a plain and an SDH track', () => {
    // The Show B S03E08 shape exactly: SDH signalled in the title only.
    const result = subtitles([
      probe.subtitle({ language: 'eng', title: 'English' }),
      probe.subtitle({ language: 'eng', title: 'English [SDH]' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags?.title).toBe('English');
  });

  it('keeps one when SDH carries its disposition flag', () => {
    const result = subtitles([
      probe.subtitle({ language: 'eng', title: 'English' }),
      probe.subtitle({ language: 'eng', hearingImpaired: true }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags?.title).toBe('English');
  });

  it('never emits two subtitle tracks, however many the source had', () => {
    const result = subtitles([
      probe.subtitle({ language: 'eng', title: 'English' }),
      probe.subtitle({ language: 'eng', title: 'English [SDH]' }),
      probe.subtitle({ language: 'eng', title: 'English (Forced)' }),
      probe.subtitle({ language: 'fre' }),
      probe.subtitle({ language: 'spa' }),
    ]);

    expect(result).toHaveLength(1);
  });

  it('keeps SDH when it is the only English subtitle', () => {
    // One track is the goal, not "no SDH". Dropping this would leave a deaf
    // viewer with nothing.
    const result = subtitles([
      probe.subtitle({ language: 'eng', title: 'English [SDH]' }),
      probe.subtitle({ language: 'fre' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags?.title).toBe('English [SDH]');
  });

  it('keeps text over an image track, which Plex would have to burn in', () => {
    // PGS/VOBSUB cannot be delivered to a client as text, so keeping one forces
    // a full video transcode - the session that was failing to begin with.
    const result = subtitles([
      probe.subtitle({ codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      probe.subtitle({ codec: 'subrip', language: 'eng' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.codec_name).toBe('subrip');
  });

  it('keeps a full image transcript over a forced text track', () => {
    // Forced covers foreign dialogue only, so as the sole track it leaves most
    // of the dialogue uncovered. Burn-in beats missing most of the words.
    const result = subtitles([
      probe.subtitle({ codec: 'subrip', language: 'eng', title: 'English (Forced)' }),
      probe.subtitle({ codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.codec_name).toBe('hdmv_pgs_subtitle');
  });

  it('leaves a file with no subtitles alone', () => {
    expect(subtitles([])).toHaveLength(0);
  });
});

/**
 * Subtitles ffmpeg cannot decode, e.g. WebVTT in Matroska. Show D
 * S01E01 carried three, and every ffmpeg command in the flow died in turn:
 *
 *   [matroska,webm] Unknown/unsupported AVCodecID S_TEXT/WEBVTT.
 *   [matroska,webm] Could not find codec parameters for stream 4
 *                   (Subtitle: none): unknown codec
 *   [matroska]      Subtitle codec 0 is not supported.
 *   [out#0/matroska] Could not write header (incorrect codec parameters ?)
 *
 * The encode, the track clean-up and the final mux all mapped the streams, so
 * all three failed and the job ended in transcodeError with the file untouched.
 * ffprobe reports such a stream with no codec_name at all, which is how they
 * are recognised - they are dropped, not kept, because nothing downstream can
 * carry them.
 */
const undecodable = (language: string) =>
  probe.stream('subtitle', { tags: { language }, disposition: {} });

describe('subtitle policy: streams ffmpeg cannot decode', () => {
  it('drops them rather than failing the job', () => {
    const result = run(probe.file({
      container: 'mkv',
      streams: [
        probe.video({ codec: 'h264' }),
        probe.audio({ codec: 'eac3', channels: 2, language: 'eng' }),
        undecodable('eng'),
        undecodable('spa'),
        undecodable('por'),
      ],
    }));

    expect(result.subtitles).toHaveLength(0);
    expect(result.halted).toBeNull();
    expect(result.replaced).toBe(true);
  });

  it('keeps a readable track standing beside an undecodable one', () => {
    const result = subtitles([
      undecodable('eng'),
      probe.subtitle({ codec: 'subrip', language: 'eng' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.codec_name).toBe('subrip');
  });
});
