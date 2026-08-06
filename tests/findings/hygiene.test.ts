import { describe, expect, it } from 'vitest';
import { lint, loadClassicPlugin, probe } from 'tdarr-flow-test';

import { flow, nodes, paths, registry } from '../support/setup.ts';

/** FINDING 6 - one classic-plugin runner is pinned to an older version. */
describe('finding 6: classic plugin runners should all be the same version', () => {
  it('uses one version of runClassicTranscodePlugin throughout', () => {
    const versions = [...new Set(flow.byPlugin('runClassicTranscodePlugin').map((n) => n.version))];
    expect(versions).toHaveLength(1);
  });

  it('reports no mixed plugin versions anywhere in the flow', () => {
    const mixed = lint(flow, { registry })
      .filter((f) => f.rule === 'mixed-plugin-versions')
      .map((f) => f.message);
    expect(mixed).toEqual([]);
  });
});

/**
 * FINDING 7 - three full file passes after the transcode.
 *
 * `CleanAudio` and `CleanSubs` are each a complete read-and-rewrite, and the
 * ffmpeg-command block then does a third. On a 30 GB remux that is two entire
 * wasted copies. Both are pure stream-language filtering that
 * `ffmpegCommandRemoveStreamByProperty` could do inside the existing block -
 * though untagged streams need care, since "" !== "eng".
 */
describe('finding 7: language cleanup should not cost two extra file passes', () => {
  it('runs at most one classic transcode plugin after the encoder', () => {
    const afterEncode = new Set<string>([nodes.cleanAudio, nodes.cleanSubs]);
    const passes = flow
      .byPlugin('runClassicTranscodePlugin')
      .filter((node) => afterEncode.has(node.id));

    expect(passes.map((p) => p.name)).toHaveLength(0);
  });
});

/** FINDING 8 - the two cleanup plugins disagree about probe arguments. */
describe('finding 8: cleanup plugins should probe consistently', () => {
  const file = probe.file({
    streams: [probe.video(), probe.audio({ language: 'fre' }), probe.audio({ language: 'eng' })],
  });

  it('gives CleanAudio the same analyzeduration/probesize as CleanSubs', () => {
    const cleanAudio = loadClassicPlugin('Tdarr_Plugin_bsh1_CleanAudio', {
      dir: paths.classicPluginDir,
    }).plugin(file, {}, { tag_language: 'eng' }, {});

    const [inputArgs = ''] = cleanAudio.preset.split(',');
    expect(inputArgs).toContain('-analyzeduration');
    expect(inputArgs).toContain('-probesize');
  });
});

/** FINDING 9 - the Reorder Streams node carries configuration that does nothing. */
describe('finding 9: Reorder Streams should not carry dead configuration', () => {
  it('has no empty ordering fields', () => {
    const reorder = flow.node(nodes.reorder).inputsDB ?? {};
    const empty = Object.entries(reorder)
      .filter(([, value]) => value === '')
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  it('does not order by channels, since only one audio stream survives', () => {
    // `Keep One Audio Stream` runs immediately before, so a channel ordering
    // can never change anything.
    const reorder = flow.node(nodes.reorder).inputsDB ?? {};
    expect(reorder.processOrder ?? '').not.toContain('channels');
  });
});

/** FINDING 11 - overlapping nodes make the editor hard to use. */
describe('finding 11: no two nodes should sit on the same coordinates', () => {
  it('reports no overlapping nodes', () => {
    const overlaps = lint(flow, { registry })
      .filter((f) => f.rule === 'overlapping-nodes')
      .map((f) => f.message);

    expect(overlaps).toEqual([]);
  });
});
