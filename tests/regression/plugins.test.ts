import { describe, expect, it } from 'vitest';
import { loadClassicPlugin, probe } from 'tdarr-flow-test';
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

  it('drops mov_text subtitles, which MKV cannot carry', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.subtitle({ codec: 'mov_text' })],
    });
    const result = call('Tdarr_Plugin_bsh1_RemuxMKV', file);

    expect(result.preset).not.toContain('-map 0:s?');
    expect(result.infoLog).toContain('Dropping mov_text');
  });

  it('keeps subtitles that are not mov_text', () => {
    const file = probe.file({
      container: 'mp4',
      streams: [probe.video(), probe.audio(), probe.subtitle({ codec: 'subrip' })],
    });
    expect(call('Tdarr_Plugin_bsh1_RemuxMKV', file).preset).toContain('-map 0:s?');
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

  it('stays a pure stream copy', () => {
    const file = probe.file({ container: 'avi', streams: [probe.video(), probe.audio()] });
    expect(call('Tdarr_Plugin_bsh1_ForceRemuxMKV', file).preset).toContain('-c copy');
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

  it('refuses to strip the last audio stream', () => {
    // Better a foreign track than a silent file.
    const file = probe.file({ streams: [probe.video(), probe.audio({ language: 'fre' })] });
    const result = call('Tdarr_Plugin_bsh1_CleanTracks', file, inputs());

    expect(result.processFile).toBe(false);
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
});
