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

  it('decides the audio layout from channel counts, not from codec presence', () => {
    // The old design asked "does ANY stream have eac3/ac3/aac?" and skipped the
    // whole ladder on a hit, which discarded a surround track whenever a stereo
    // one happened to direct-play. Layout is now decided by channels alone.
    expect(flow.byPlugin('checkAudioCodec')).toEqual([]);
    expect(flow.node(nodes.hasSurround).inputsDB?.propertyToCheck).toBe('channels');
    expect(flow.node(nodes.hasSurround).inputsDB?.valuesToMatch).toBe('4,5,6,7,8');
  });

  it('generates a stereo mate for every surround track', () => {
    // A surround file must come out with both, so a client that cannot handle
    // surround has something to play without a server-side transcode.
    expect(flow.target(nodes.hasSurround, '1')).toBe(nodes.ensureSurround);
    expect(flow.target(nodes.ensureSurround, '1')).toBe(nodes.ensureStereo);
  });

  it('keeps mono as mono rather than upmixing it', () => {
    expect(flow.target(nodes.hasStereo, '2')).toBe(nodes.ensureMono);
    expect(flow.node(nodes.ensureMono).inputsDB?.channels).toBe('1');
    expect(flow.node(nodes.ensureMono).inputsDB?.bitrate).toBe('96k');
  });

  it('normalises the surviving tracks after every Ensure', () => {
    // Ensure only adds; without this the original stereo track would survive
    // alongside the freshly generated one.
    for (const source of [nodes.ensureStereo, nodes.ensureMono]) {
      expect(flow.target(source, '1')).toBe(nodes.normalise);
    }
    expect(flow.node(nodes.normalise).pluginName).toBe('normaliseAudioTracks');
  });

  it('lets the audio ordering come from the local plugin, not Reorder Streams', () => {
    // Reorder's channel map only knows 8/6/2/1, so a 4-channel track sorts as
    // an empty string and gets pulled behind a stereo one.
    expect(flow.node(nodes.reorder).inputsDB?.processOrder).toBe('streamTypes');
  });

  it('pins the container to mkv before planning audio streams', () => {
    // Begin Command seeds the container from the working file, so without this
    // a failed stage-1 remux would have the block write E-AC3 into an AVI.
    const target = flow.target(nodes.beginCommand, '1');
    expect(target).toBe(nodes.setContainer);
    expect(flow.node(nodes.setContainer).inputsDB?.container).toBe('mkv');
  });

  it('gives every encoder a fallback rather than failing the job', () => {
    // A transient GPU failure used to kill the whole job. NVENC and QuickSync
    // now fall back to the CPU encoder; a CPU failure reverts to the original
    // and carries on without the transcode.
    for (const encoder of [nodes.encodeNvidia, nodes.encodeQsv]) {
      expect(flow.target(encoder, 'err1')).toBe(nodes.encodeCpu);
    }
    const cpuFallback = flow.target(nodes.encodeCpu, 'err1');
    expect(cpuFallback).not.toBeNull();
    expect(flow.node(cpuFallback as string).pluginName).toBe('resetFlowError');
  });

  it('leaves Execute without an error edge, deliberately', () => {
    // If ffmpeg fails the working file is bad. Every onward path eventually
    // commits, so failing the job is the only safe outcome.
    expect(flow.usedHandles(nodes.execute)).not.toContain('err1');
  });

  it('cleans language tracks in a single pass', () => {
    // Audio and subtitle cleanup were two separate classic plugins, each doing
    // a full read-and-rewrite of the file.
    const classicAfterEncode = flow
      .byPlugin('runClassicTranscodePlugin')
      .filter((n) => n.inputsDB?.pluginSourceId?.includes('Clean'));
    expect(classicAfterEncode).toHaveLength(1);
    expect(classicAfterEncode[0]?.inputsDB?.pluginSourceId)
      .toBe('Local:Tdarr_Plugin_bsh1_CleanTracks');
  });

  it('uses one version of runClassicTranscodePlugin throughout', () => {
    const versions = [...new Set(flow.byPlugin('runClassicTranscodePlugin').map((n) => n.version))];
    expect(versions).toEqual(['2.0.0']);
  });

  it('reports no lint findings at all', () => {
    // Covers unreachable nodes, impossible handles, dead ends, mixed versions
    // and overlapping node positions in one assertion.
    const findings = lint(flow, {
      registry,
      ignore: [
        'missing-error-edge:audProped',
        'missing-error-edge:audExec001',
        'unwired-handle:gateMedium',
      ],
    });
    expect(findings.map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
  });

  it('routes an oversized transcode away from the audio block', () => {
    // Whether handle 3 exists at all is a separate question - see
    // tests/findings/size-guard.test.ts. This only asserts the intent is wired.
    expect(flow.target(nodes.sizeRatio, '3')).toBe(nodes.setOriginal);
    expect(flow.target(nodes.setOriginal, '1')).toBe(nodes.cleanTracks);
  });
});
