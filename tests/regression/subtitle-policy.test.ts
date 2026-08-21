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

  it('leaves a file with no subtitles alone', () => {
    expect(subtitles([])).toHaveLength(0);
  });
});
