import { describe, expect, it } from 'vitest';
import { probe } from 'tdarr-flow-test';

import { run } from '../support/setup.ts';

/**
 * FINDING 1 - a stereo compatible track beats a surround incompatible one.
 *
 * The `Has EAC3?/AC3?/AAC?` checks use `checkAudioCodec`, which is true if ANY
 * audio stream matches. They run before `Keep One Audio Stream`, so the
 * decision is made on the whole stream set rather than on the track the flow
 * will actually keep.
 *
 * The pass-through policy is deliberate and correct: leave audio alone when it
 * already direct-plays. What is not deliberate is *which* track that policy
 * ends up preserving when a compatible stereo track sits alongside an
 * incompatible surround one.
 */
describe('finding 1: surround must survive a compatible stereo companion', () => {
  it('keeps 5.1 when the file is DTS 5.1 + AAC 2.0', () => {
    // A very common web-dl / x265 layout.
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'dts', channels: 6, language: 'eng' }),
          probe.audio({ codec: 'aac', channels: 2, language: 'eng' }),
        ],
      }),
    );

    expect(result.halted).toBeNull();
    expect(result.audio).toHaveLength(1);
    expect(
      result.audio[0]?.channels,
      `kept ${result.audio[0]?.codec_name} ${result.audio[0]?.channels}ch - `
        + 'the 5.1 track was discarded in favour of a stereo one',
    ).toBe(6);
  });

  it('keeps 5.1 when the file is TrueHD 7.1 + AC3 2.0', () => {
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'truehd', channels: 8, language: 'eng' }),
          probe.audio({ codec: 'ac3', channels: 2, language: 'eng' }),
        ],
      }),
    );

    expect(result.audio[0]?.channels).toBeGreaterThanOrEqual(6);
  });

  it('still keeps the compatible track when it is the higher channel count', () => {
    // The control: pass-through is right here, and a fix must not break it by
    // re-encoding a track that was already fine.
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'ac3', channels: 6, language: 'eng' }),
          probe.audio({ codec: 'dts', channels: 2, language: 'eng' }),
        ],
      }),
    );

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('ac3');
    expect(result.audio[0]?.channels).toBe(6);
  });
});

/**
 * FINDING 2 (NARROWED) - a file whose only audio is non-English comes out
 * silent.
 *
 * Originally this was framed around untagged audio. Running the REAL
 * `ffmpegCommandEnsureAudioStream` disproved that: it does not require a
 * language-tagged source, so untagged DTS/FLAC are converted correctly. Those
 * cases now live in tests/regression/audio-policy.test.ts.
 *
 * What survives is narrower and worse. `CleanAudio` deliberately refuses to
 * strip the last audio stream, so a French-only file reaches the audio block
 * intact. `Ensure EAC3` is configured with `language: eng`, finds no English
 * source, and adds nothing. `Drop Incompatible Audio` then removes the DTS
 * unconditionally, and nothing checks that anything is left.
 *
 * This directly contradicts the README's stated behaviour: "A file with no
 * English audio keeps its foreign track."
 */
describe('finding 2: a file with only foreign audio must not come out silent', () => {
  it('keeps the track when the only audio is French DTS', () => {
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'dts', channels: 6, language: 'fre' }),
        ],
      }),
    );

    expect(result.halted).toBeNull();
    expect(result.audio.length, 'the file came out silent').toBeGreaterThanOrEqual(1);
  });

  it('keeps the track when the only audio is Japanese FLAC', () => {
    const result = run(
      probe.file({
        streams: [
          probe.video({ codec: 'h264' }),
          probe.audio({ codec: 'flac', channels: 2, language: 'jpn' }),
        ],
      }),
    );

    expect(result.audio.length, 'the file came out silent').toBeGreaterThanOrEqual(1);
  });
});

/**
 * FINDING 12 (found by `tdarr-test fuzz`) - a file whose every stream gets
 * stripped kills the job.
 *
 * Same root cause as finding 2, but fatal rather than silent. When there is no
 * video stream to keep, dropping the only (foreign) audio leaves the ffmpeg
 * command with nothing mapped, and the real `ffmpegCommandExecute` throws
 * "No streams mapped for new file". `Execute` has no error edge, so the whole
 * job fails.
 *
 * Reached via audio-only files and by video files whose only subtitle track is
 * foreign. A guard that refuses to remove the last audio stream fixes both this
 * and finding 2.
 */
describe('finding 12: stripping every stream must not kill the job', () => {
  it('survives an audio-only file whose only track is foreign', () => {
    const result = run(
      probe.file({
        container: 'mkv',
        streams: [probe.audio({ codec: 'dts', channels: 6, language: 'fre' })],
      }),
    );

    expect(result.halted, `flow died: ${result.halted?.message ?? ''}`).toBeNull();
  });

  it('survives a file whose only streams are foreign subtitles', () => {
    const result = run(
      probe.file({
        container: 'mkv',
        streams: [probe.subtitle({ language: 'fre' })],
      }),
    );

    expect(result.halted, `flow died: ${result.halted?.message ?? ''}`).toBeNull();
  });
});
