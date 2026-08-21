"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Normalise Audio Tracks',
    description: 'Reduce the audio streams to at most one surround track and one stereo/mono '
        + 'track, preferring the target codec. Replaces the drop/keep-one pair: those could not '
        + 'express "keep two", and dropping by codec alone left the original stereo track '
        + 'alongside a freshly generated one. Never leaves the file with no audio. Also owns '
        + 'the kept tracks\' default flags and caps their bitrate at what the source carried.',
    style: {
        borderColor: '#6efefc',
    },
    tags: 'audio',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: '',
    inputs: [
        {
            label: 'Target Codec',
            name: 'targetCodec',
            type: 'string',
            defaultValue: 'eac3',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Streams in this codec win over equivalent streams in any other codec.',
        },
        {
            label: 'Surround Minimum Channels',
            name: 'surroundMinChannels',
            type: 'string',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Streams with at least this many channels count as surround.',
        },
        {
            label: 'Bitrate Floor',
            name: 'bitrateFloor',
            type: 'string',
            defaultValue: '128k',
            inputUI: {
                type: 'text',
            },
            tooltip: 'A track is never capped below this, however thin its source. '
                + 'Set to 0 to disable the cap entirely.',
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
// higher is better; ties fall through to the earlier stream in the file
var makeIsBetter = function (targetCodec) { return function (candidate, incumbent) {
    var candidateTarget = candidate.codec_name === targetCodec ? 1 : 0;
    var incumbentTarget = incumbent.codec_name === targetCodec ? 1 : 0;
    if (candidateTarget !== incumbentTarget) {
        return candidateTarget > incumbentTarget;
    }
    var candidateChannels = Number(candidate.channels || 0);
    var incumbentChannels = Number(incumbent.channels || 0);
    if (candidateChannels !== incumbentChannels) {
        return candidateChannels > incumbentChannels;
    }
    return Number(candidate.bit_rate || 0) > Number(incumbent.bit_rate || 0);
}; };
var pickBest = function (candidates, isBetter) {
    var best = candidates[0];
    for (var i = 1; i < candidates.length; i += 1) {
        if (isBetter(candidates[i], best)) {
            best = candidates[i];
        }
    }
    return best;
};
// ffmpeg treats "-ac"/"-ar" without a stream specifier as applying to EVERY
// output stream, so two audio encodes in one command collide: the second one's
// "-ac 2" silently overrides the first one's "-ac 6" and both tracks come out
// stereo. Observed for real - it turned an AC3 5.1 track into stereo while
// reporting success.
//
// "Ensure Audio Stream" also clones the highest-channel stream to build a new
// one, which means a second Ensure inherits the first's outputArgs verbatim.
// So the same option can appear twice on a single stream too.
//
// This rewrites each kept stream's args to: one entry per option, last value
// wins, and per-stream specifiers on the ones that need them.
var UNQUALIFIED_PER_STREAM_OPTS = ['-ac', '-ar'];
var baseFlag = function (flag) { return String(flag).split(':')[0]; };
var qualifyOutputArgs = function (args) {
    var order = [];
    var latest = {};
    for (var i = 0; i < args.length - 1; i += 2) {
        var flag = String(args[i]);
        var base = baseFlag(flag);
        if (order.indexOf(base) === -1) {
            order.push(base);
        }
        latest[base] = { flag: flag, value: args[i + 1] };
    }
    var out = [];
    for (var j = 0; j < order.length; j += 1) {
        var entry = latest[order[j]];
        var outFlag = entry.flag;
        if (UNQUALIFIED_PER_STREAM_OPTS.indexOf(outFlag) !== -1) {
            outFlag = outFlag + ':{outputIndex}';
        }
        out.push(outFlag, entry.value);
    }
    return out;
};
// Bitrate is configured on the Ensure nodes as a flat number, which is right
// for a fat source and wasteful for a thin one: a 197kbps HE-AAC web-rip re-encoded
// to E-AC3 384k + 192k grew a 633MB file to 801MB, spending 2.9x the bitrate to
// carry strictly less information than the source had. Cap at what was actually
// there, rounded down to a sane E-AC3 step, never below the floor.
var BITRATE_STEP_KBPS = 32;
var parseKbps = function (value) {
    var match = /^(\d+)k?$/i.exec(String(value).trim());
    return match ? Number(match[1]) : null;
};
// What the source carried. Matroska rarely fills ffprobe's bit_rate, so the BPS
// tag mkvmerge and mkvpropedit write is usually the only answer available.
var sourceKbps = function (stream) {
    var direct = Number(stream.bit_rate || 0);
    if (direct > 0) {
        return direct / 1000;
    }
    var tags = stream.tags || {};
    var bps = Number(tags.BPS || tags.bps || 0);
    return bps > 0 ? bps / 1000 : null;
};
// Rewrites the surviving "-b:a:..." value in place. Returns the bitrate the
// stream will actually be encoded at, or null if it is not being encoded.
var capBitrate = function (stream, floorKbps, log) {
    var args = stream.outputArgs || [];
    var effective = null;
    for (var i = 0; i < args.length - 1; i += 2) {
        if (baseFlag(args[i]) !== '-b') {
            continue;
        }
        var requested = parseKbps(args[i + 1]);
        if (requested === null) {
            continue;
        }
        effective = requested;
        var source = sourceKbps(stream);
        if (floorKbps <= 0 || source === null || source >= requested) {
            continue;
        }
        var stepped = Math.floor(source / BITRATE_STEP_KBPS) * BITRATE_STEP_KBPS;
        var capped = Math.min(requested, Math.max(floorKbps, stepped));
        if (capped < requested) {
            args[i + 1] = capped + 'k';
            effective = capped;
            log("Capped index ".concat(stream.index, " from ").concat(requested, "k to ")
                .concat(capped, "k; the source carried ").concat(Math.round(source), "k \n"));
        }
    }
    return effective;
};
// "Ensure Audio Stream" builds a track by deep-cloning the source stream, so
// every generated track inherits the source's default flag. Two Ensure nodes
// therefore produce two tracks both flagged default, which is a malformed MKV -
// the spec allows one default per track type - and players disagree about what
// to do with it. Observed for real: a file Plex refused to transcode.
//
// ffmpeg copies dispositions from the input stream unless told otherwise, so
// fixing the planned stream alone changes nothing in the output file. The
// "-disposition" arg is what actually lands.
var DISPOSITION_FLAG = '-disposition:{outputIndex}';
var COPY_ARGS = ['-c:{outputIndex}', 'copy'];
var hasCodecArg = function (args) {
    for (var i = 0; i < args.length - 1; i += 2) {
        if (/^-(c|codec)(:|$)/.test(String(args[i]))) {
            return true;
        }
    }
    return false;
};
var applyDisposition = function (stream, wantDefault) {
    var args = stream.outputArgs || [];
    var kept = [];
    for (var i = 0; i < args.length - 1; i += 2) {
        if (baseFlag(args[i]) === '-disposition') {
            continue;
        }
        kept.push(args[i], args[i + 1]);
    }
    // A pass-through stream has no args at all, and Execute only adds "-c copy"
    // for a stream whose args are empty or disposition/metadata-only. That
    // carve-out is a property of one Execute version; say "copy" explicitly so
    // adding a disposition can never turn a remux into a re-encode.
    if (!hasCodecArg(kept)) {
        kept = COPY_ARGS.concat(kept);
    }
    kept.push(DISPOSITION_FLAG, wantDefault ? 'default' : '0');
    // eslint-disable-next-line no-param-reassign
    stream.outputArgs = kept;
    // eslint-disable-next-line no-param-reassign
    stream.disposition = Object.assign({}, stream.disposition, { default: wantDefault ? 1 : 0 });
};
var isDefault = function (stream) {
    return Number((stream.disposition || {}).default || 0) === 1;
};
var describe = function (stream) {
    var lang = (stream.tags && stream.tags.language) || 'untagged';
    return "index ".concat(stream.index, " (").concat(stream.codec_name, ", ")
        .concat(stream.channels, " channels, ").concat(lang, ")");
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (args) {
    var flowUtils_1 = require('../../../../FlowHelpers/1.0.0/interfaces/flowUtils');
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    (0, flowUtils_1.checkFfmpegCommandInit)(args);
    var targetCodec = String(args.inputs.targetCodec);
    var surroundMin = Number(args.inputs.surroundMinChannels);
    var floorKbps = parseKbps(args.inputs.bitrateFloor) || 0;
    var isBetter = makeIsBetter(targetCodec);
    var streams = args.variables.ffmpegCommand.streams;
    var audioStreams = streams.filter(function (stream) {
        return stream.codec_type === 'audio' && !stream.removed;
    });
    if (audioStreams.length === 0) {
        args.jobLog('No audio streams to normalise \n');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var surround = audioStreams.filter(function (stream) {
        return Number(stream.channels || 0) >= surroundMin;
    });
    var stereo = audioStreams.filter(function (stream) {
        return Number(stream.channels || 0) < surroundMin;
    });
    var keep = [];
    if (surround.length > 0) {
        keep.push(pickBest(surround, isBetter));
    }
    if (stereo.length > 0) {
        keep.push(pickBest(stereo, isBetter));
    }
    // Cannot happen given the guard above, but a silent file is bad enough to
    // be worth the belt and braces: an empty stream map also fails the job.
    if (keep.length === 0) {
        args.jobLog('⚠ Refusing to remove every audio stream \n');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    keep.forEach(function (stream) {
        args.jobLog("Keeping audio ".concat(describe(stream), " \n"));
        if (stream.outputArgs && stream.outputArgs.length > 0) {
            var before = stream.outputArgs.join(' ');
            // eslint-disable-next-line no-param-reassign
            stream.outputArgs = qualifyOutputArgs(stream.outputArgs);
            var after = stream.outputArgs.join(' ');
            if (before !== after) {
                args.jobLog("Rewrote args for index ".concat(stream.index, ": ")
                    .concat(before, " -> ").concat(after, " \n"));
            }
        }
        var encodedAt = capBitrate(stream, floorKbps, args.jobLog);
        if (encodedAt !== null) {
            // Keep the planned stream honest: until now it carried the *source*
            // bitrate it was cloned from, which misleads every later comparison.
            // eslint-disable-next-line no-param-reassign
            stream.bit_rate = String(encodedAt * 1000);
        }
    });
    var removed = 0;
    audioStreams.forEach(function (stream) {
        if (keep.indexOf(stream) === -1) {
            args.jobLog("Removing audio ".concat(describe(stream), " \n"));
            // eslint-disable-next-line no-param-reassign
            stream.removed = true;
            removed += 1;
        }
    });
    if (removed > 0) {
        // eslint-disable-next-line no-param-reassign
        args.variables.ffmpegCommand.shouldProcess = true;
    }
    // Exactly one default audio track, and it is the one listed first. Only
    // touch the command when the file does not already say so, or every pass
    // over an already-correct library would rewrite every file.
    var dispositionWrong = keep.some(function (stream, index) {
        return isDefault(stream) !== (index === 0);
    });
    if (dispositionWrong) {
        keep.forEach(function (stream, index) {
            applyDisposition(stream, index === 0);
        });
        args.jobLog("Default audio flag set on index ".concat(keep[0].index, " and cleared on ")
            .concat(keep.length > 1 ? "index ".concat(keep[1].index) : 'nothing else', " \n"));
        // eslint-disable-next-line no-param-reassign
        args.variables.ffmpegCommand.shouldProcess = true;
    }
    // Put the surround track first. Execute maps streams in array order, and
    // players generally default to the first audio track, so this decides what
    // you actually hear. "Reorder Streams" cannot do it: its channel map only
    // knows 8/6/2/1, so a 4-channel track sorts as an empty string and lands
    // wherever it started.
    if (keep.length === 2) {
        var surroundKeep = keep[0];
        var stereoKeep = keep[1];
        var surroundAt = streams.indexOf(surroundKeep);
        var stereoAt = streams.indexOf(stereoKeep);
        if (surroundAt > stereoAt) {
            streams[stereoAt] = surroundKeep;
            streams[surroundAt] = stereoKeep;
            args.jobLog('Moved the surround track ahead of the stereo track \n');
            // eslint-disable-next-line no-param-reassign
            args.variables.ffmpegCommand.shouldProcess = true;
        }
    }
    // E-AC3 carries 256 samples of encoder delay. The Matroska muxer records
    // that as CodecDelay and a reader reports the first packet at -0.005s,
    // unless the muxer shifted the whole file to compensate. ffmpeg's default
    // "-avoid_negative_ts auto" shifts only when it decides it must, so the
    // outcome varies with interleaving rather than with the input: Show B S03E07
    // came out with every stream at >= 0, S03E08 with its stereo track at
    // -0.005. A negative start upsets seeking and some transcoders outright.
    // Pin it instead of hoping.
    //
    // Only when something is being rewritten anyway. Execute sets shouldProcess
    // whenever overallOuputArguments is non-empty, so adding this
    // unconditionally would rewrite every file in the library on every pass,
    // for ever.
    if (args.variables.ffmpegCommand.shouldProcess) {
        var overall = args.variables.ffmpegCommand.overallOuputArguments;
        if (overall.indexOf('-avoid_negative_ts') === -1) {
            overall.push('-avoid_negative_ts', 'make_zero');
            args.jobLog('Pinned the output timestamp origin to zero \n');
        }
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
