import { describe, expect, it } from 'vitest';
import { lint } from 'tdarr-flow-test';

import { flow, nodes, registry } from '../support/setup.ts';

/**
 * Structural invariants that hold today. If a fix for one of the findings
 * breaks one of these, the fix broke something that was working.
 */
describe('flow structure', () => {
  it('has exactly one entry node, and it is Input File', () => {
    expect(flow.entry().pluginName).toBe('inputFile');
  });

  it('every edge points at a node that exists', () => {
    for (const edge of flow.edges) {
      expect(flow.byId.has(edge.source), `edge ${edge.id} source`).toBe(true);
      expect(flow.byId.has(edge.target), `edge ${edge.id} target`).toBe(true);
    }
  });

  it('has no unreachable nodes', () => {
    const findings = lint(flow, { registry }).filter((f) => f.rule === 'unreachable-node');
    expect(findings.map((f) => f.nodeName)).toEqual([]);
  });

  it('models every plugin the flow uses', () => {
    const unmodelled = lint(flow, { registry })
      .filter((f) => f.rule === 'unmodelled-plugin')
      .map((f) => f.nodeName);
    expect(unmodelled).toEqual([]);
  });

  it('terminates only at Replace Original File', () => {
    const terminals = flow.terminals();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.pluginName).toBe('replaceOriginalFile');
  });
});

describe('invariants the pipeline depends on', () => {
  it('gates every Run MKVPropEdit behind an Is MKV? check', () => {
    // mkvpropedit refuses non-Matroska input, fails the node, and drags the
    // job to transcodeError even when the media itself is fine.
    for (const propedit of flow.byPlugin('runMkvPropEdit')) {
      const sources = flow.incoming(propedit.id).map((edge) => flow.node(edge.source));
      const plugins = [...new Set(sources.map((s) => s.pluginName))];
      expect(plugins, `${propedit.id} is reached from ${plugins.join(', ')}`)
        .toEqual(['checkFileExtension']);
    }
  });

  it('drops incompatible audio with not_equals, never not_includes', () => {
    // The plugin substring-matches for the *includes* conditions, and
    // "eac3".includes("ac3") is true, which would silently keep the wrong
    // stream.
    const drop = flow.node(nodes.dropIncompatible);
    expect(drop.inputsDB?.condition).toBe('not_equals');
    expect(drop.inputsDB?.valuesToRemove).toBe('eac3,ac3,aac');
  });

  it('tests channel counts largest-first', () => {
    // checkChannelCount matches exactly, so a file carrying both a 5.1 track
    // and a stereo commentary must hit the 5.1 tier. Checking 2ch first would
    // mis-tier it.
    const ladder: number[] = [];
    let id: string | null = nodes.ch6;
    while (id !== null && flow.node(id).pluginName === 'checkChannelCount') {
      ladder.push(Number(flow.node(id).inputsDB?.channelCount));
      id = flow.target(id, '2');
    }
    expect(ladder).toEqual([6, 8, 2, 1]);
  });

  it('falls through to the 384k tier rather than the smallest', () => {
    // An unusual count (4ch, 7ch) must keep the previous behaviour rather than
    // being quietly downgraded.
    const fallthrough = flow.target(nodes.ch1, '2');
    expect(fallthrough).not.toBeNull();
    expect(flow.node(fallthrough as string).inputsDB?.bitrate).toBe('384k');
  });

  it('reduces to one audio stream only after the codec drop', () => {
    // Picking a favourite first could select a stream the drop step then
    // removes, leaving the file with no audio at all.
    expect(flow.target(nodes.dropIncompatible, '1')).toBe(nodes.keepOne);
  });

  it('pins the container to mkv before planning audio streams', () => {
    // Begin Command seeds the container from the working file, so without this
    // a failed stage-1 remux would have the block write E-AC3 into an AVI.
    const target = flow.target(nodes.beginCommand, '1');
    expect(target).toBe(nodes.setContainer);
    expect(flow.node(nodes.setContainer).inputsDB?.container).toBe('mkv');
  });

  it('routes an oversized transcode away from the audio block', () => {
    // Whether handle 3 exists at all is a separate question - see
    // tests/findings/size-guard.test.ts. This only asserts the intent is wired.
    expect(flow.target(nodes.sizeRatio, '3')).toBe(nodes.setOriginal);
    expect(flow.target(nodes.setOriginal, '1')).toBe(nodes.cleanAudio);
  });
});
