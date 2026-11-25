"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Notify Plex',
    description: 'Tell Plex about the file just replaced: rescan its folder, then re-analyse the '
        + 'item, since a rescan alone keeps the codec Plex recorded for the old file. Optional: '
        + 'with no Plex URL or token configured it does nothing. Never fails the job - the file '
        + 'is already committed by the time this runs.',
    style: {
        borderColor: 'green',
    },
    tags: 'plex',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faBell',
    inputs: [
        {
            label: 'Plex URL',
            name: 'plexUrl',
            type: 'string',
            defaultValue: '{{{args.userVariables.global.plex_url}}}',
            inputUI: {
                type: 'text',
            },
            tooltip: 'e.g. http://192.168.1.10:32400. Leave empty, or leave the global variable '
                + 'unset, to skip this step.',
        },
        {
            label: 'Plex Token',
            name: 'plexToken',
            type: 'string',
            defaultValue: '{{{args.userVariables.global.plex_token}}}',
            inputUI: {
                type: 'text',
            },
            tooltip: 'X-Plex-Token. Keep it in a global variable so it never lands in an exported flow.',
        },
        {
            label: 'Path Mapping',
            name: 'pathMap',
            type: 'string',
            defaultValue: '{{{args.userVariables.global.plex_path_map}}}',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Where Tdarr and Plex mount the library at different paths: '
                + '"<tdarr prefix>=<plex prefix>", several separated by commas, e.g. '
                + '"/media=/data". Leave empty when both see the same paths.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Continue to next plugin',
        },
    ],
}); };
exports.details = details;

// Tdarr substitutes {{{args.*}}} in inputs, but an unset variable is not
// guaranteed to come back empty, so resolve it here too and treat anything that
// still looks like a template as unset.
var resolve = function (raw, args) {
    var value = raw === undefined || raw === null ? '' : String(raw).trim();
    var match = /^\{\{\{args\.(.+)\}\}\}$/.exec(value);
    if (match) {
        var resolved = match[1].split('.').reduce(function (obj, key) { return (obj == null ? undefined : obj[key]); }, args);
        value = resolved === undefined || resolved === null ? '' : String(resolved).trim();
    }
    if (value === 'undefined' || value.indexOf('{{{') !== -1)
        return '';
    return value;
};
exports.resolve = resolve;

var parsePathMap = function (raw) { return raw.split(',')
    .map(function (pair) { return pair.trim(); })
    .filter(function (pair) { return pair !== ''; })
    .map(function (pair) {
    var at = pair.indexOf('=');
    if (at <= 0)
        throw new Error("Path Mapping entry \"".concat(pair, "\" is not <tdarr prefix>=<plex prefix>"));
    return { from: pair.slice(0, at).trim(), to: pair.slice(at + 1).trim() };
}); };

var stripSlash = function (p) { return (p.length > 1 ? p.replace(/\/+$/, '') : p); };

var isUnder = function (path, prefix) {
    var base = stripSlash(prefix);
    return path === base || path.indexOf("".concat(base, "/")) === 0;
};

var toPlexPath = function (path, mappings) {
    // Longest prefix wins, so a mapping for a subfolder beats one for its parent.
    var match = mappings
        .filter(function (m) { return isUnder(path, m.from); })
        .sort(function (a, b) { return b.from.length - a.from.length; })[0];
    return match ? stripSlash(match.to) + path.slice(stripSlash(match.from).length) : path;
};
exports.toPlexPath = toPlexPath;

var dirOf = function (path) { return path.slice(0, path.lastIndexOf('/')) || '/'; };

// The section whose location holds the folder; the deepest location wins when
// libraries nest.
var findSection = function (sections, dir) {
    var best;
    sections.forEach(function (section) {
        (section.Location || []).forEach(function (location) {
            if (isUnder(dir, location.path) && (!best || location.path.length > best.length)) {
                best = {
                    key: section.key, title: section.title, type: section.type, length: location.path.length,
                };
            }
        });
    });
    return best;
};
exports.findSection = findSection;

// Plex's file filter is rejected on a show library unless it names the episode type.
var ITEM_TYPE = { movie: 1, show: 4 };

var request = function (args, url, token, method) {
    var verb = method || 'get';
    var headers = { Accept: 'application/json', 'X-Plex-Token': token };
    if (args.deps && args.deps.axios) {
        return args.deps.axios({ method: verb, url: url, headers: headers, timeout: 15000 })
            .then(function (res) { return res.data; });
    }
    return fetch(url, { method: verb.toUpperCase(), headers: headers, signal: AbortSignal.timeout(15000) }).then(function (res) {
        if (!res.ok)
            throw new Error("HTTP ".concat(res.status));
        return res.text().then(function (text) { return (text ? JSON.parse(text) : {}); });
    });
};

// A rescan picks up a new or renamed file, and Plex analyses those itself. It
// does not re-analyse a file it already knows under the same path, even when
// its size changed: Film A (2026) kept "h264" after an HEVC re-encode with the
// new size already recorded. So find the item by its exact path and analyse it.
var analyse = function (args, base, token, section, file) {
    var type = ITEM_TYPE[section.type];
    if (!type) {
        args.jobLog("Notify Plex: library type \"".concat(section.type, "\" not supported for re-analysis."));
        return undefined;
    }
    var url = "".concat(base, "/library/sections/").concat(section.key, "/all?type=").concat(type, "&file=").concat(encodeURIComponent(file));
    return request(args, url, token).then(function (data) {
        // The filter matches substrings, so keep only exact part paths.
        var items = ((data && data.MediaContainer && data.MediaContainer.Metadata) || []).filter(function (item) {
            return (item.Media || []).some(function (media) {
                return (media.Part || []).some(function (part) { return part.file === file; });
            });
        });
        if (items.length === 0) {
            args.jobLog('Notify Plex: file not in Plex yet; the rescan will add and analyse it.');
            return undefined;
        }
        return Promise.all(items.map(function (item) {
            return request(args, "".concat(base, "/library/metadata/").concat(item.ratingKey, "/analyze"), token, 'put')
                .then(function () {
                args.jobLog("Notify Plex: asked Plex to re-analyse \"".concat(item.title, "\" (").concat(item.ratingKey, ")"));
            });
        }));
    });
};

var notify = function (args, plexUrl, token, pathMap) { return Promise.resolve().then(function () {
    // Replace Original File hands on the committed path, which carries the new
    // extension when the container changed (.mp4 -> .mkv).
    var file = toPlexPath(args.inputFileObj._id, parsePathMap(pathMap));
    var dir = dirOf(file);
    var base = plexUrl.replace(/\/+$/, '');
    return request(args, "".concat(base, "/library/sections"), token).then(function (data) {
        var sections = (data && data.MediaContainer && data.MediaContainer.Directory) || [];
        var section = findSection(sections, dir);
        if (!section) {
            args.jobLog("Notify Plex: no Plex library contains ".concat(dir, "; check Path Mapping. Skipping."));
            return undefined;
        }
        var url = "".concat(base, "/library/sections/").concat(section.key, "/refresh?path=").concat(encodeURIComponent(dir));
        return request(args, url, token).then(function () {
            args.jobLog("Notify Plex: asked library \"".concat(section.title, "\" to rescan ").concat(dir));
            return analyse(args, base, token, section, file);
        });
    });
}).catch(function (err) {
    args.jobLog("Notify Plex: failed, continuing anyway: ".concat(err && err.message ? err.message : String(err)));
}); };

var plugin = function (args) {
    var plexUrl = resolve(args.inputs && args.inputs.plexUrl !== undefined
        ? args.inputs.plexUrl : details().inputs[0].defaultValue, args);
    var token = resolve(args.inputs && args.inputs.plexToken !== undefined
        ? args.inputs.plexToken : details().inputs[1].defaultValue, args);
    var pathMap = resolve(args.inputs && args.inputs.pathMap !== undefined
        ? args.inputs.pathMap : details().inputs[2].defaultValue, args);
    var result = {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
    // Unconfigured is the common case and returns synchronously: nothing to wait for.
    if (!plexUrl || !token) {
        args.jobLog('Notify Plex: no Plex URL or token configured, skipping.');
        return result;
    }
    return notify(args, plexUrl, token, pathMap).then(function () { return result; });
};
exports.plugin = plugin;
