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
  /** The flow as it was before the readability and audio guards were added. */
  preGuardFlow: join(repoRoot, 'tests', 'fixtures', 'transcode-pipeline.pre-guards.json'),
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

/** Same as `run`, against a different flow - used to replay captured logs. */
export function runOn(
  target: Flow,
  file: TdarrFile,
  options: Partial<SimulateOptions> = {},
): SimulationResult {
  return simulate(target, file, {
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
  cleanTracks: 'aQKzSWY-r',
  beginCommand: 'audStart01',
  setContainer: 'audSetCont',
  hasSurround: 'audHasSurr',
  hasStereo: 'audHasSter',
  ensureSurround: 'audEnsSurr',
  ensureStereo: 'audEnsSt',
  ensureMono: 'audEnsMono',
  normalise: 'audNorm',
  mediumGate: 'gateMedium',
  reorder: 'audReorder',
  execute: 'audExec001',
  fileChanged: 'audChgChk',
  finalPropEdit: 'audProped',
  replace: 'XLXwY90TH',
} as const;
