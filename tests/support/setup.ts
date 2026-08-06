import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  Flow,
  buildRegistry,
  simulate,
  type SimulateOptions,
  type SimulationResult,
} from 'tdarr-flow-test';
import type { TdarrFile } from 'tdarr-flow-test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  flow: join(repoRoot, 'flows', 'transcode-pipeline.json'),
  classicPluginDir: join(repoRoot, 'plugins', 'Local'),
  flowPluginDir: join(repoRoot, 'plugins', 'FlowPlugins', 'LocalFlowPlugins'),
};

export const flow = Flow.fromFile(paths.flow);

export const registry = buildRegistry({
  classicPluginDir: paths.classicPluginDir,
  flowPluginDir: paths.flowPluginDir,
});

/** Runs a file through the real flow with this repo's real plugins. */
export function run(file: TdarrFile, options: Partial<SimulateOptions> = {}): SimulationResult {
  return simulate(flow, file, {
    nodeName: 'Nvidia',
    classicPluginDir: paths.classicPluginDir,
    flowPluginDir: paths.flowPluginDir,
    registry,
    ...options,
  });
}

/**
 * Node ids referenced by tests. Named so a rename in the editor produces one
 * clear failure rather than a scatter of unexplained ones.
 */
export const nodes = {
  remux: 'M_mrP-J_d',
  forceRemux: 'TOqGPovz0',
  isHevc: '3AOkEqifp',
  encodeNvidia: 'aRB7_yBQE',
  encodeQsv: 'L5oZNsSMG',
  encodeCpu: 'audCpuEnc',
  sizeRatio: 'JBA2N2W7L',
  setOriginal: 'ksKmTCZB0',
  cleanAudio: 'aQKzSWY-r',
  cleanSubs: 'ZvfzKZ6Nw',
  beginCommand: 'audStart01',
  setContainer: 'audSetCont',
  hasEac3: 'audChkEac',
  hasAc3: 'audChkAc3',
  hasAac: 'audChkAac',
  ch6: 'audCh6',
  ch8: 'audCh8',
  ch2: 'audCh2',
  ch1: 'audCh1',
  ensure384: 'audEnsure1',
  ensure192: 'audEns192',
  ensure96: 'audEns96',
  dropIncompatible: 'audStrip01',
  keepOne: 'audKeep1',
  reorder: 'audReorder',
  execute: 'audExec001',
  fileChanged: 'audChgChk',
  finalPropEdit: 'audProped',
  replace: 'XLXwY90TH',
} as const;
