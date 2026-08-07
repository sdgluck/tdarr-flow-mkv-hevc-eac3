"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Normalise Audio Tracks',
    description: 'Reduce the audio streams to at most one surround track and one stereo/mono '
        + 'track, preferring the target codec. Replaces the drop/keep-one pair: those could not '
        + 'express "keep two", and dropping by codec alone left the original stereo track '
        + 'alongside a freshly generated one. Never leaves the file with no audio.',
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
var qualifyOutputArgs = function (args) {
    var order = [];
    var latest = {};
    for (var i = 0; i < args.length - 1; i += 2) {
        var flag = String(args[i]);
        var base = flag.split(':')[0];
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
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
