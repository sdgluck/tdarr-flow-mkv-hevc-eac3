"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
var details = function () { return ({
    name: 'Keep One Audio Stream',
    description: 'Keep a single audio stream and remove the rest. '
        + 'Prefers the specified language, then the highest channel count, then the highest bitrate.',
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
            label: 'Language',
            name: 'language',
            type: 'string',
            defaultValue: 'eng',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Preferred language tag, e.g. eng. Streams whose language tag contains this value '
                + 'win over those that do not. Leave blank to ignore language.',
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
var scoreStream = function (stream, langTag) {
    var _a;
    var langMatch = 0;
    if (langTag) {
        var lang = (_a = stream === null || stream === void 0 ? void 0 : stream.tags) === null || _a === void 0 ? void 0 : _a.language;
        if (lang && String(lang).toLowerCase().includes(langTag)) {
            langMatch = 1;
        }
    }
    return {
        langMatch: langMatch,
        channels: Number(stream.channels || 0),
        bitRate: Number(stream.bit_rate || 0),
    };
};
// higher is better; ties fall through to the earlier stream in the file
var isBetter = function (candidate, incumbent) {
    if (candidate.langMatch !== incumbent.langMatch) {
        return candidate.langMatch > incumbent.langMatch;
    }
    if (candidate.channels !== incumbent.channels) {
        return candidate.channels > incumbent.channels;
    }
    return candidate.bitRate > incumbent.bitRate;
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (args) {
    var flowUtils_1 = require('../../../../FlowHelpers/1.0.0/interfaces/flowUtils');
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    (0, flowUtils_1.checkFfmpegCommandInit)(args);
    var langTag = String(args.inputs.language || '').toLowerCase();
    var streams = args.variables.ffmpegCommand.streams;
    var audioStreams = streams.filter(function (stream) { return stream.codec_type === 'audio' && !stream.removed; });
    if (audioStreams.length <= 1) {
        args.jobLog("".concat(audioStreams.length, " audio stream(s) present, nothing to remove \n"));
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    var keep = audioStreams[0];
    var keepScore = scoreStream(keep, langTag);
    for (var i = 1; i < audioStreams.length; i += 1) {
        var score = scoreStream(audioStreams[i], langTag);
        if (isBetter(score, keepScore)) {
            keep = audioStreams[i];
            keepScore = score;
        }
    }
    args.jobLog("Keeping audio stream index ".concat(keep.index, " (").concat(keep.codec_name, ", ")
        + "".concat(keepScore.channels, " channels, lang match: ").concat(keepScore.langMatch === 1, ") \n"));
    var removedCount = 0;
    audioStreams.forEach(function (stream) {
        if (stream !== keep) {
            args.jobLog("Removing audio stream index ".concat(stream.index, " (").concat(stream.codec_name, ", ")
                + "".concat(stream.channels, " channels) \n"));
            // eslint-disable-next-line no-param-reassign
            stream.removed = true;
            removedCount += 1;
        }
    });
    if (removedCount > 0) {
        // eslint-disable-next-line no-param-reassign
        args.variables.ffmpegCommand.shouldProcess = true;
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
