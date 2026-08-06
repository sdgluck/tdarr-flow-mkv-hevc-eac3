import { describe, expect, it } from 'vitest';
import { lint, probe } from 'tdarr-flow-test';

import { flow, nodes, registry, run } from '../support/setup.ts';

/**
 * FINDING 3 - an unreadable source kills the job at Begin Command.
 *
 * `ffmpegCommandStart` throws outright when ffprobe returned nothing, and it
 * exposes no error handle, so there is nothing to catch it. A truncated
 * download burns two failed remuxes and a transcode attempt and then ends as
 * `transcodeError`, which reads like a pipeline fault rather than a bad file.
 *
 * The fix is a readability guard early in the flow, not an error edge -
 * `ffmpegCommandStart` has no err1 handle to wire.
 */
describe('finding 3: an unreadable source must exit cleanly', () => {
  it('does not crash on a truncated MP4 with no probeable streams', () => {
    const result = run(probe.unreadableFile({ container: 'mp4', name: 'truncated.mp4' }));

    expect(
      result.halted?.kind,
      `flow died: ${result.halted?.message ?? ''}`,
    ).not.toBe('crash');
  });

  it('leaves the library file untouched when the source is unreadable', () => {
    // This part already works, and must keep working whatever guard is added.
    expect(run(probe.unreadableFile({ container: 'mp4' })).replaced).toBe(false);
  });

  it('does not attempt a transcode on a file it could not read', () => {
    const result = run(probe.unreadableFile({ container: 'mp4' }));
    const wasted = result.visited.filter((name) => name.startsWith('Transcode HEVC'));

    expect(wasted, 'ran an encoder against a file with no video stream').toEqual([]);
  });
});

/**
 * FINDING 5 - the encoders and Execute have no error edge.
 *
 * A transient GPU failure fails the entire job rather than falling back. With
 * two nodes of differing hardware available, an NVENC failure routing to the
 * CPU encoder is cheap and obviously correct.
 *
 * `audProped` is exempt: routing its failure onward would commit a possibly-bad
 * transcode, which is the documented reason it has no error edge.
 */
describe('finding 5: nodes that can fail should handle failure', () => {
  const exempt = new Set<string>([nodes.finalPropEdit]);

  it('gives every failure-capable node an error edge', () => {
    const missing = lint(flow, { registry })
      .filter((f) => f.rule === 'missing-error-edge')
      .filter((f) => f.nodeId !== undefined && !exempt.has(f.nodeId))
      .map((f) => `${f.nodeName} (${f.nodeId})`);

    expect(missing).toEqual([]);
  });

  it('falls back to another encoder when the GPU encode fails', () => {
    // Asserts the wiring exists; which encoder it falls back to is a design
    // choice, so this only requires that the error handle goes somewhere.
    for (const encoder of [nodes.encodeNvidia, nodes.encodeQsv, nodes.encodeCpu]) {
      expect(
        flow.usedHandles(encoder),
        `${flow.node(encoder).name} has no error edge`,
      ).toContain('err1');
    }
  });
});
