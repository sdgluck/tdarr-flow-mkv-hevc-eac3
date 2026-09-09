import { describe, expect, it } from 'vitest';
import { loadClassicPlugin, loadFlowPlugin, probe } from 'tdarr-flow-test';
import type { ClassicPluginInputs, TdarrFile } from 'tdarr-flow-test';

import { paths } from '../support/setup.ts';

const call = (id: string, file: TdarrFile, inputs: ClassicPluginInputs = {}) =>
  loadClassicPlugin(id, { dir: paths.classicPluginDir }).plugin(file, {}, inputs, {});

describe('RemuxMKV', () => {
  it('no-ops on a file that is already MKV', () => {
    const file = probe.file({ container: 'mkv', streams: [probe.video(), probe.audio()] });
    expect(call('Tdarr_Plugin_bsh1_RemuxMKV', file).processFile).toBe(false);
  });

  it('passes -fflags +genpts as an INPUT arg', () => {
    // DivX-packed AVI carries packets with no timestamps; without generated
    // timestamps the matroska muxer writes a truncated stub. The flag must land
    // before the comma that separates input from output args, or it does
    // nothing at all.
    const file = probe.file({
      container: 'avi',
      streams: [probe.video({ codec: 'mpeg4' }), probe.audio()],
    });
    const result = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(result.processFile).toBe(true);
    expect(result.preset.split(',')[0]).toContain('-fflags +genpts');
  });

  // MKV cannot carry mov_text (tx3g). Dropping every subtitle the moment one
  // appeared threw away perfectly good SRT tracks standing beside it.
  it('converts mov_text to SRT when nothing else carries the dialogue as text', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.subtitle({ codec: 'mov_text' })],
    });
    const result = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(result.preset).toContain('-map 0:2');
    expect(result.preset).toContain('-c:s:0 srt');
    expect(result.infoLog).toContain('Converting 1 mov_text');
  });

  it('keeps a companion SRT instead of dropping it with the mov_text', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ codec: 'mov_text' }),
        probe.subtitle({ codec: 'subrip' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(result.preset).toContain('-map 0:3');
    expect(result.preset).not.toContain('-map 0:2');
    expect(result.preset).not.toContain('srt');
    expect(result.infoLog).toContain('Dropping 1 mov_text');
  });

  it('converts mov_text even when the only companion is an image track', () => {
    // PGS is not text, so it cannot stand in for the dialogue.
    const file = probe.file({
      container: 'mp4',
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ codec: 'hdmv_pgs_subtitle' }),
        probe.subtitle({ codec: 'mov_text' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(result.preset).toContain('-map 0:2');
    expect(result.preset).toContain('-map 0:3');
    // Second subtitle output stream, so :1 - not the input index.
    expect(result.preset).toContain('-c:s:1 srt');
  });

  // ffmpeg resolves a per-stream option by taking the LAST instance that
  // matches the stream, and "-c copy" carries no specifier, so it matches the
  // subtitle stream too. With "-c:s:N srt" written first the override is
  // discarded, mov_text is stream-copied into Matroska after all, and the mux
  // dies at the header - the exact failure the conversion exists to prevent.
  it.each([
    ['Tdarr_Plugin_bsh1_RemuxMKV'],
    ['Tdarr_Plugin_bsh1_ForceRemuxMKV'],
  ])('orders -c copy before the per-stream SRT override (%s)', (id) => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.subtitle({ codec: 'mov_text' })],
    });
    const { preset } = call(id, file);

    expect(preset).toContain('-c:s:0 srt');
    expect(preset.indexOf('-c copy')).toBeLessThan(preset.indexOf('-c:s:0 srt'));
  });

  it('keeps subtitles that are not mov_text', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.subtitle({ codec: 'subrip' })],
    });
    expect(call('Tdarr_Plugin_bsh1_RemuxMKV', file).preset).toContain('-map 0:s?');
  });

  // An ASS/SSA subtitle names the fonts it wants and Matroska carries them as
  // attachment streams. "-map 0:s?" does not select those, so a remux that
  // lists its maps explicitly dropped them and the subtitle rendered in
  // whatever the player substituted.
  it.each([
    ['Tdarr_Plugin_bsh1_RemuxMKV'],
    ['Tdarr_Plugin_bsh1_ForceRemuxMKV'],
  ])('carries font attachments across the remux (%s)', (id) => {
    const file = probe.file({
      container: 'mp4',
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ codec: 'ass' }),
        probe.stream('attachment', { codec_name: 'ttf' }),
      ],
    });
    expect(call(id, file).preset).toContain('-map 0:t?');
  });

  it('still strips attached-picture cover art, which is not an attachment', () => {
    // Cover art is a video stream with disposition.attached_pic, selected by
    // 0:v and excluded by the uppercase 0:V - "-map 0:t?" does not bring it
    // back in.
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.attachedPic()],
    });
    const { preset } = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(preset).toContain('-map 0:V:0');
    expect(preset).not.toContain('-map 0:v');
  });

  it('maps 0:V:0 so attached pictures never reach the muxer', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.attachedPic()],
    });
    expect(call('Tdarr_Plugin_bsh1_RemuxMKV', file).preset).toContain('-map 0:V:0');
  });
});

describe('ForceRemuxMKV', () => {
  it('accepts a non-MKV container', () => {
    const file = probe.file({ container: 'mp4', streams: [probe.video(), probe.audio()] });
    const result = call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file);

    expect(result.processFile).toBe(true);
    expect(result.infoLog).toContain('Force remuxing mp4 to MKV');
  });

  it('is strictly more permissive than RemuxMKV', () => {
    // If the two presets are equivalent the escalation just re-runs the same
    // command and fails identically. They were byte-identical once.
    const file = probe.file({ container: 'avi', streams: [probe.video(), probe.audio()] });
    const normal = call('Tdarr_Plugin_bsh1_RemuxMKV', file).preset;
    const forced = call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file).preset;

    expect(forced).not.toBe(normal);
    for (const flag of ['+igndts', '-err_detect ignore_err', '-analyzeduration', '-probesize']) {
      expect(forced).toContain(flag);
    }
  });

  // ForceRemux only ever runs on a file a normal remux could not handle, which
  // is exactly where a stream ffmpeg cannot decode turns up. Mapping one kills
  // the whole command at the header ("Subtitle codec 0 is not supported"), so
  // the escalation would fail for the same reason its predecessor did. This
  // copy of planSubtitles had drifted and kept the pre-1.2.0 version.
  it('drops subtitle streams ffmpeg cannot decode', () => {
    const file = probe.file({
      container: 'mkv',
      streams: [
        probe.video(),
        probe.audio(),
        probe.stream('subtitle', { tags: { language: 'eng' }, disposition: {} }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file);

    expect(result.preset).toContain('-map -0:2');
    expect(result.infoLog).toContain('unreadable subtitle stream');
  });

  it('never names an undecodable stream on the mov_text path either', () => {
    // The mov_text branch maps kept streams one by one, so an unreadable one is
    // excluded by never being named - but only if it was filtered out first.
    const file = probe.file({
      container: 'mp4',
      streams: [
        probe.video(),
        probe.audio(),
        probe.stream('subtitle', { tags: { language: 'eng' }, disposition: {} }),
        probe.subtitle({ codec: 'mov_text' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file);

    expect(result.preset).not.toContain('-map 0:2');
    expect(result.preset).toContain('-map 0:3');
    expect(result.preset).toContain('-c:s:0 srt');
  });

  it('plans subtitles identically to RemuxMKV', () => {
    // The two copies are deployed as separate files with nowhere to share from,
    // so the only guard against them drifting again is this.
    const file = probe.file({
      container: 'mp4',
      streams: [
        probe.video(),
        probe.audio(),
        probe.stream('subtitle', { tags: { language: 'eng' }, disposition: {} }),
        probe.subtitle({ codec: 'mov_text' }),
        probe.subtitle({ codec: 'hdmv_pgs_subtitle' }),
      ],
    });
    // Everything the two presets legitimately disagree on is an input arg or a
    // trailing muxer flag; the stream plan itself has to match token for token.
    const subtitlePlan = (id: string) => call(id, file).preset
      .match(/-map -?0:\S+|-c:s:\d+ \w+/g) ?? [];

    expect(subtitlePlan('Tdarr_Plugin_bsh1_ForceRemuxMKV'))
      .toEqual(subtitlePlan('Tdarr_Plugin_bsh1_RemuxMKV'));
  });

  it('stays a pure stream copy', () => {
    const file = probe.file({ container: 'avi', streams: [probe.video(), probe.audio()] });
    expect(call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file).preset).toContain('-c copy');
  });
});

describe('CleanTracks attachments', () => {
  const inputs = { tag_language: 'eng', remove_commentary: 'true', remove_sdh: 'false' };
  const withFont = (container: string) => probe.file({
    container,
    streams: [
      probe.video(),
      probe.audio({ language: 'eng' }),
      probe.audio({ language: 'fra' }),
      probe.subtitle({ codec: 'ass', language: 'eng' }),
      probe.stream('attachment', { codec_name: 'ttf' }),
    ],
  });

  it('carries font attachments through the language clean-up', () => {
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', withFont('mkv'), inputs);

    expect(result.processFile).toBe(true);
    expect(result.preset).toContain('-map 0:t?');
  });

  it('leaves attachments unmapped into a container that cannot hold them', () => {
    // Reached only when both remux attempts failed and the file is still in its
    // original container. MP4 has nowhere to put an attachment, and mapping one
    // fails the mux rather than being ignored.
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', withFont('mp4'), inputs).preset)
      .not.toContain('-map 0:t?');
  });
});

describe('CleanTracks', () => {
  const inputs = (overrides: ClassicPluginInputs = {}) => ({
    tag_language: 'eng',
    remove_commentary: 'true',
    remove_sdh: 'false',
    ...overrides,
  });

  it('removes non-English audio and subtitles in one pass', () => {
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio({ language: 'eng' }),
        probe.audio({ language: 'fre' }),
        probe.subtitle({ language: 'fre' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(true);
    expect(result.preset).toContain('-map -0:2');
    expect(result.preset).toContain('-map -0:3');
  });

  it('passes analyzeduration and probesize as input args', () => {
    // The two plugins this replaced disagreed about this.
    const file = probe.file({
      streams: [probe.video(), probe.audio({ language: 'fre' }), probe.audio({ language: 'eng' })],
    });
    const [inputArgs = ''] = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).preset.split(',');

    expect(inputArgs).toContain('-analyzeduration');
    expect(inputArgs).toContain('-probesize');
  });

  it('refuses to leave the file with no audio', () => {
    // Better a foreign track than a silent file.
    const file = probe.file({ streams: [probe.video(), probe.audio({ language: 'fre' })] });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(false);
    expect(result.infoLog).toContain('would leave no audio');
  });

  it('keeps every audio track, not just one, when they would all go', () => {
    // The rule is "never leave the file silent", not "keep one". Picking a
    // single track here would mean choosing between languages on a file where
    // the flow has no basis to choose, and the audio block downstream reduces
    // to one surround and one stereo track anyway.
    // A foreign subtitle gives the pass something to do, so there is a real
    // preset to inspect rather than the empty string of a no-op.
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio({ language: 'fre', channels: 6 }),
        probe.audio({ language: 'deu', channels: 2 }),
        probe.subtitle({ codec: 'subrip', language: 'fre' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(true);
    expect(result.preset).toContain('-map -0:3');
    expect(result.preset).not.toContain('-map -0:1');
    expect(result.preset).not.toContain('-map -0:2');
    expect(result.infoLog).toContain('would leave no audio');
  });

  it('still removes foreign subtitles when it has to keep foreign audio', () => {
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio({ language: 'fre' }),
        probe.subtitle({ language: 'fre' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(true);
    expect(result.preset).toContain('-map -0:2');
    expect(result.preset).not.toContain('-map -0:1');
  });

  it('keeps audio that carries no language tag', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio({ language: null }), probe.audio({ language: 'fre' })],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.preset).toContain('-map -0:2');
    expect(result.preset).not.toContain('-map -0:1');
  });

  it('keeps SDH when remove_sdh is false, even with remove_commentary on', () => {
    // Folding the sdh title test into the commentary test silently deleted SDH
    // tracks, and most releases label SDH in the title only.
    const file = probe.file({
      streams: [probe.video(), probe.audio(), probe.subtitle({ title: 'English SDH' })],
    });
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).processFile).toBe(false);
  });

  it('recognises SDH by disposition as well as by title', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio(), probe.subtitle({ hearingImpaired: true })],
    });
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).processFile).toBe(false);
  });

  it('removes SDH when remove_sdh is true', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio(), probe.subtitle({ title: 'English SDH' })],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs({ remove_sdh: 'true' }));
    expect(result.preset).toContain('-map -0:2');
  });

  it('removes commentary identified by the disposition flag', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio(), probe.subtitle({ commentary: true })],
    });
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).preset).toContain('-map -0:2');
  });

  // Two English text tracks with nothing to tell them apart is what killed the
  // Show B S03E08 Plex session: "srt muxer does not support more than one stream
  // of type subtitle". Exactly one track survives, so no selector can match two.
  it('collapses two English subtitles to one, keeping the plain track', () => {
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ title: 'English' }),
        probe.subtitle({ title: 'English [SDH]' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(true);
    expect(result.preset).toContain('-map -0:3');
    expect(result.preset).not.toContain('-map -0:2');
  });

  it('collapses on the SDH disposition too, not just the title', () => {
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ hearingImpaired: true }),
        probe.subtitle({ title: 'English' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.preset).toContain('-map -0:2');
    expect(result.preset).not.toContain('-map -0:3');
  });

  it('keeps a full transcript over a forced track', () => {
    // Forced carries foreign dialogue only: the worst possible sole subtitle.
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ title: 'English (Forced)' }),
        probe.subtitle({ title: 'English [SDH]' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.preset).toContain('-map -0:2');
    expect(result.preset).not.toContain('-map -0:3');
  });

  it('keeps SDH when it is the only English subtitle', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio(), probe.subtitle({ title: 'English [SDH]' })],
    });
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).processFile).toBe(false);
  });

  it('leaves a compliant single-subtitle file alone', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio({ language: 'eng' }), probe.subtitle({ language: 'eng' })],
    });
    expect(call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs()).processFile).toBe(false);
  });

  it('counts only the survivors, not tracks it already dropped', () => {
    // A foreign sub alongside one English sub must not look like "two kept".
    const file = probe.file({
      streams: [
        probe.video(),
        probe.audio(),
        probe.subtitle({ language: 'eng' }),
        probe.subtitle({ language: 'fre' }),
      ],
    });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.preset).toContain('-map -0:3');
    expect(result.preset).not.toContain('-map -0:2');
  });
});

/**
 * Normalise Audio Tracks, driven directly. The simulator asserts the *effect*
 * on the output streams; these assert the ffmpeg arguments that produce it,
 * which is the half that decides what the real file looks like.
 */
const normalise = (
  streams: Record<string, unknown>[],
  inputs: Record<string, string> = {},
) => {
  const command = {
    init: true,
    inputFiles: [],
    streams: streams.map((s, index) => ({
      index,
      codec_type: 'audio',
      removed: false,
      inputArgs: [],
      outputArgs: [],
      disposition: {},
      tags: { language: 'eng' },
      ...s,
    })),
    container: 'mkv',
    hardwareDecoding: false,
    shouldProcess: false,
    overallInputArguments: [],
    overallOuputArguments: [],
  };
  const messages: string[] = [];
  loadFlowPlugin('normaliseAudioTracks', {
    dir: paths.flowPluginDir,
    category: 'audio',
  }).plugin({
    inputs,
    variables: { ffmpegCommand: command },
    inputFileObj: probe.file({ streams: [] }),
    jobLog: (line: string) => messages.push(line),
  } as never);

  return { command, messages, kept: command.streams.filter((s) => !s.removed) };
};

describe('normaliseAudioTracks arguments', () => {
  it('emits -disposition, because ffmpeg copies the flag from the input otherwise', () => {
    // Both generated tracks are mapped from the same default-flagged source
    // stream, so fixing the planned stream alone changes nothing in the file.
    const { kept } = normalise([
      { codec_name: 'eac3', channels: 6, disposition: { default: 1 }, outputArgs: ['-c:{outputIndex}', 'eac3'] },
      { codec_name: 'eac3', channels: 2, disposition: { default: 1 }, outputArgs: ['-c:{outputIndex}', 'eac3'] },
    ]);

    expect(kept[0]?.outputArgs.join(' ')).toContain('-disposition:{outputIndex} default');
    expect(kept[1]?.outputArgs.join(' ')).toContain('-disposition:{outputIndex} 0');
  });

  it('keeps "copy" explicit on a pass-through track it flags', () => {
    // Execute only supplies "-c copy" for a stream whose args are empty or
    // disposition-only. That carve-out belongs to one Execute version; without
    // saying copy ourselves, adding a disposition could turn a remux into a
    // re-encode at ffmpeg's default codec.
    const { kept } = normalise([
      { codec_name: 'eac3', channels: 6, disposition: { default: 0 } },
    ]);

    expect(kept[0]?.outputArgs.join(' '))
      .toBe('-c:{outputIndex} copy -disposition:{outputIndex} default');
  });

  it('leaves the command alone when the flags are already right', () => {
    const { command } = normalise([
      { codec_name: 'eac3', channels: 6, disposition: { default: 1 } },
      { codec_name: 'eac3', channels: 2, disposition: { default: 0 } },
    ]);

    expect(command.shouldProcess, 'a compliant file was queued for a rewrite').toBe(false);
    expect(command.streams.every((s) => s.outputArgs.length === 0)).toBe(true);
  });

  it('caps the bitrate arg at the source BPS tag', () => {
    const { kept, messages } = normalise([
      {
        codec_name: 'eac3',
        channels: 6,
        tags: { language: 'eng', BPS: '196900' },
        outputArgs: ['-c:{outputIndex}', 'eac3', '-b:a:{outputTypeIndex}', '384k'],
      },
    ]);

    expect(kept[0]?.outputArgs.join(' ')).toContain('-b:a:{outputTypeIndex} 192k');
    expect(messages.join('')).toContain('the source carried 197k');
  });

  it('does not touch a bitrate the source can justify', () => {
    const { kept } = normalise([
      {
        codec_name: 'eac3',
        channels: 6,
        bit_rate: '1500000',
        outputArgs: ['-c:{outputIndex}', 'eac3', '-b:a:{outputTypeIndex}', '384k'],
      },
    ]);

    expect(kept[0]?.outputArgs.join(' ')).toContain('-b:a:{outputTypeIndex} 384k');
  });

  // E-AC3's 256 samples of encoder delay become a Matroska CodecDelay, and a
  // reader reports the first packet at -0.005s unless the muxer shifted the
  // file to compensate. ffmpeg's default "auto" shifts only when it decides it
  // must, so it lands intermittently: Show B S03E07 came out clean, S03E08 with
  // its stereo track negative.
  it('pins the timestamp origin when it is rewriting the file', () => {
    const { command } = normalise([
      { codec_name: 'eac3', channels: 6, disposition: { default: 1 }, outputArgs: ['-c:{outputIndex}', 'eac3'] },
      { codec_name: 'eac3', channels: 2, disposition: { default: 1 }, outputArgs: ['-c:{outputIndex}', 'eac3'] },
    ]);

    expect(command.overallOuputArguments.join(' ')).toBe('-avoid_negative_ts make_zero');
  });

  it('adds no overall argument to a compliant file', () => {
    // Execute forces shouldProcess whenever overallOuputArguments is non-empty,
    // so an unconditional mux argument would rewrite the whole library on every
    // pass, for ever.
    const { command } = normalise([
      { codec_name: 'eac3', channels: 6, disposition: { default: 1 } },
      { codec_name: 'eac3', channels: 2, disposition: { default: 0 } },
    ]);

    expect(command.overallOuputArguments).toEqual([]);
    expect(command.shouldProcess, 'a compliant file was queued for a rewrite').toBe(false);
  });
});
