import { describe, expect, it } from 'vitest';
import { loadFlowPlugin } from 'tdarr-flow-test';

import { paths } from '../support/setup.ts';

const notifyPlex = loadFlowPlugin('notifyPlex', {
  dir: paths.flowPluginDir,
  category: 'tools',
}) as unknown as {
  plugin: (args: unknown) => unknown;
  resolve: (raw: unknown, args: unknown) => string;
  toPlexPath: (path: string, mappings: { from: string; to: string }[]) => string;
  findSection: (
    sections: { key: string; title: string; Location?: { path: string }[] }[],
    dir: string,
  ) => { key: string; title: string; type?: string } | undefined;
};

const sections = {
  MediaContainer: {
    Directory: [
      { key: '1', title: 'Films', type: 'movie', Location: [{ path: '/data/film' }] },
      { key: '2', title: 'TV', type: 'show', Location: [{ path: '/data/tv' }] },
    ],
  },
};

const LIBRARY_FILE = '/media/film/Film A (2026)/Film A (2026) WEBDL-1080p.mkv';
const PLEX_FILE = '/data/film/Film A (2026)/Film A (2026) WEBDL-1080p.mkv';

const item = (ratingKey: string, file: string) => ({
  ratingKey,
  title: 'Film A',
  Media: [{ Part: [{ file }] }],
});

/** A Plex that knows the film, plus a near-namesake the substring filter also returns. */
const plex = (url: string): unknown => {
  if (url.endsWith('/library/sections')) return sections;
  if (url.includes('/all?')) {
    return { MediaContainer: { Metadata: [item('101', PLEX_FILE), item('99', `${PLEX_FILE}.bak`)] } };
  }
  return {};
};

function run(
  inputs: Record<string, string>,
  respond: (url: string) => unknown = plex,
  file = LIBRARY_FILE,
) {
  const calls: { url: string; token: string; method: string }[] = [];
  const log: string[] = [];
  const args = {
    inputs,
    variables: {},
    inputFileObj: { _id: file },
    originalLibraryFile: { _id: LIBRARY_FILE.replace(/\.mkv$/, '.mp4') },
    userVariables: { global: {} },
    jobLog: (line: string) => log.push(line),
    deps: {
      axios: async (config: { url: string; method: string; headers: Record<string, string> }) => {
        calls.push({ url: config.url, method: config.method, token: config.headers['X-Plex-Token'] ?? '' });
        const data = respond(config.url);
        if (data instanceof Error) throw data;
        return { status: 200, data };
      },
    },
  };
  return { result: notifyPlex.plugin(args), calls, log };
}

describe('Notify Plex is optional', () => {
  it('does nothing, synchronously, when no global variables are set', () => {
    // The flow ships with the inputs pointing at unset globals. Returning a plain
    // object keeps it runnable in the synchronous simulator and costs Tdarr nothing.
    const { result, calls, log } = run({
      plexUrl: '{{{args.userVariables.global.plex_url}}}',
      plexToken: '{{{args.userVariables.global.plex_token}}}',
      pathMap: '{{{args.userVariables.global.plex_path_map}}}',
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { outputNumber: number }).outputNumber).toBe(1);
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('skipping');
  });

  it('treats a template Tdarr left unresolved, or rendered as "undefined", as unset', () => {
    expect(notifyPlex.resolve('{{{args.userVariables.global.nope}}}', {})).toBe('');
    expect(notifyPlex.resolve('undefined', {})).toBe('');
    expect(notifyPlex.resolve('{{{args.a.b}}}', { a: { b: ' x ' } })).toBe('x');
  });

  it('skips when only one of URL and token is set', () => {
    expect(run({ plexUrl: 'http://plex:32400', plexToken: '' }).calls).toEqual([]);
    expect(run({ plexUrl: '', plexToken: 'tok' }).calls).toEqual([]);
  });
});

describe('Notify Plex when configured', () => {
  it('rescans the folder, then re-analyses exactly the committed file', async () => {
    // A rescan alone is not enough: Plex had Film A (2026) at the HEVC file's
    // new size and still recorded "h264" until the item was analysed.
    const { result, calls, log } = run({
      plexUrl: 'http://plex:32400/',
      plexToken: 'tok',
      pathMap: '/media=/data',
    });
    expect((await result as { outputNumber: number }).outputNumber).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'get http://plex:32400/library/sections',
      `get http://plex:32400/library/sections/1/refresh?path=${encodeURIComponent('/data/film/Film A (2026)')}`,
      `get http://plex:32400/library/sections/1/all?type=1&file=${encodeURIComponent(PLEX_FILE)}`,
      'put http://plex:32400/library/metadata/101/analyze',
    ]);
    expect(calls.every((c) => c.token === 'tok')).toBe(true);
    expect(log.join('\n')).toContain('"Films"');
  });

  it('looks up episodes by episode type, which a show library requires', async () => {
    const { result, calls } = run(
      { plexUrl: 'http://plex:32400', plexToken: 'tok', pathMap: '/media=/data' },
      plex,
      '/media/tv/Show/Season 1/Show - S01E01.mkv',
    );
    await result;
    expect(calls[2]?.url).toContain('/library/sections/2/all?type=4&file=');
  });

  it('leaves a file Plex does not know yet to the rescan', async () => {
    const { result, calls, log } = run(
      { plexUrl: 'http://plex:32400', plexToken: 'tok', pathMap: '/media=/data' },
      (url) => (url.includes('/all?') ? { MediaContainer: {} } : plex(url)),
    );
    await result;
    expect(calls.filter((c) => c.method === 'put')).toEqual([]);
    expect(log.join('\n')).toContain('not in Plex yet');
  });

  it('never fails the job: the file is already committed', async () => {
    const { result, log } = run(
      { plexUrl: 'http://plex:32400', plexToken: 'tok', pathMap: '/media=/data' },
      () => new Error('connect ECONNREFUSED'),
    );
    expect((await result as { outputNumber: number }).outputNumber).toBe(1);
    expect(log.join('\n')).toContain('ECONNREFUSED');
  });

  it('logs and continues when no Plex library holds the folder', async () => {
    const { result, calls, log } = run({ plexUrl: 'http://plex:32400', plexToken: 'tok' });
    expect((await result as { outputNumber: number }).outputNumber).toBe(1);
    expect(calls).toHaveLength(1);
    expect(log.join('\n')).toContain('no Plex library contains /media/film/Film A (2026)');
  });

  it('reports a malformed Path Mapping instead of throwing', async () => {
    const { result, log } = run({ plexUrl: 'http://plex:32400', plexToken: 'tok', pathMap: '/media' });
    expect((await result as { outputNumber: number }).outputNumber).toBe(1);
    expect(log.join('\n')).toContain('not <tdarr prefix>=<plex prefix>');
  });
});

describe('path handling', () => {
  it('maps on whole path segments, longest prefix first', () => {
    const map = [{ from: '/media', to: '/data' }, { from: '/media/film', to: '/movies' }];
    expect(notifyPlex.toPlexPath('/media/film/X', map)).toBe('/movies/X');
    expect(notifyPlex.toPlexPath('/media/tv/X', map)).toBe('/data/tv/X');
    expect(notifyPlex.toPlexPath('/mediafoo/X', map)).toBe('/mediafoo/X');
  });

  it('matches library locations on whole segments, deepest first', () => {
    const libs = [
      { key: '1', title: 'All', Location: [{ path: '/data' }] },
      { key: '2', title: 'Films', Location: [{ path: '/data/film/' }] },
    ];
    expect(notifyPlex.findSection(libs, '/data/film/X')?.key).toBe('2');
    expect(notifyPlex.findSection(libs, '/data/films/X')?.key).toBe('1');
    expect(notifyPlex.findSection(libs, '/other/X')).toBeUndefined();
  });
});
