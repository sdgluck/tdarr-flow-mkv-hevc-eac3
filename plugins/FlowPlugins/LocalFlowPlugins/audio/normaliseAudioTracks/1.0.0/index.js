"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Normalise Audio Tracks',
    description: 'Reduce the audio streams to at most one surround track and one stereo/mono '
        + 'track, preferring the target codec. Replaces the drop/keep-one pair: those could not '
        + 'express "keep two", and dropping by codec alone left the original stereo track '
        + 'alongside a freshly generated one. Never leaves the file with no audio. Also owns '
        + 'the kept tracks\' default flags and caps their bitrate at what the source carried. '
        + 'Prefers the configured language, so a foreign track never wins a tie.',
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
            label: 'Preferred Language',
            name: 'preferredLanguage',
            type: 'string',
            defaultValue: 'eng',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Streams tagged with this language win over equivalent streams in any '
                + 'other language. Leave empty to ignore language entirely.',
        },
        {
            label: 'Surround Bitrate',
            name: 'surroundBitrate',
            type: 'string',
            defaultValue: '384k',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Bitrate for an original-language surround track this node encodes. '
                + 'The English tracks take theirs from the Ensure nodes.',
        },
        {
            label: 'Stereo Bitrate',
            name: 'stereoBitrate',
            type: 'string',
            defaultValue: '192k',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Bitrate for an original-language stereo track this node encodes.',
        },
        {
            label: 'Mono Bitrate',
            name: 'monoBitrate',
            type: 'string',
            defaultValue: '96k',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Bitrate for an original-language mono track this node encodes.',
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
// Language outranks everything else. A wrong-codec track is a track you can
// still watch; a wrong-language one is not. Observed for real: a file with
// spa/por/eng stereo tracks, identical in codec, channels and bitrate, came out
// Spanish-only because the tie fell through to the first stream in the file.
//
// Untagged sits between a match and a mismatch, matching CleanTracks: an
// untagged track is far more often the main one than a foreign one.
var languageScore = function (stream, preferred) {
    if (!preferred) {
        return 0;
    }
    var lang = String(((stream.tags || {}).language || '')).toLowerCase();
    if (!lang) {
        return 1;
    }
    return lang === preferred ? 2 : 0;
};
// higher is better; ties fall through to the earlier stream in the file
var makeIsBetter = function (targetCodec, preferredLanguage) {
    return function (candidate, incumbent) {
        var candidateLang = languageScore(candidate, preferredLanguage);
        var incumbentLang = languageScore(incumbent, preferredLanguage);
        if (candidateLang !== incumbentLang) {
            return candidateLang > incumbentLang;
        }
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
    };
};
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
// The film's original language, by the same rule CleanTracks uses to decide
// what to keep: the "original" disposition, else the single default audio
// track, read from the library file as downloaded. The working file is no good:
// ffmpeg's Matroska muxer flags the first track default when the input flagged
// none, so by now "default" may only mean "first".
var DESCRIPTION_TITLE = /descri(ption|ptive)|visually impaired/i;
var languageOf = function (stream) {
    return String(((stream.tags || {}).language || '')).toLowerCase();
};
var originalAudioLanguage = function (file) {
    var streams = ((file || {}).ffProbeData || {}).streams || [];
    var audio = streams.filter(function (stream) {
        var d = stream.disposition || {};
        var title = String((stream.tags || {}).title || '');
        return stream.codec_type === 'audio' && d.comment !== 1 && d.visual_impaired !== 1
            && d.descriptions !== 1 && !DESCRIPTION_TITLE.test(title);
    });
    var flagged = audio.filter(function (stream) { return (stream.disposition || {}).original === 1; });
    var pick = flagged.length > 0 ? flagged
        : audio.filter(function (stream) { return (stream.disposition || {}).default === 1; });
    var langs = pick.map(languageOf).filter(function (lang, i, all) { return all.indexOf(lang) === i; });
    if (langs.length !== 1 || !langs[0] || langs[0] === 'und') {
        return null;
    }
    return langs[0];
};
var EAC3_MAX_CHANNELS = 6;
var encodeArgs = function (codec, channels, bitrate) {
    return ['-c:{outputIndex}', codec, '-ac:{outputIndex}', String(channels),
        '-b:a:{outputTypeIndex}', bitrate];
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
    var preferredLanguage = String(args.inputs.preferredLanguage || '').trim().toLowerCase();
    var surroundMin = Number(args.inputs.surroundMinChannels);
    var floorKbps = parseKbps(args.inputs.bitrateFloor) || 0;
    var isBetter = makeIsBetter(targetCodec, preferredLanguage);
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
    var isSurround = function (stream) { return Number(stream.channels || 0) >= surroundMin; };
    var pickTiers = function (candidates) {
        var tiers = [];
        var surround = candidates.filter(isSurround);
        var stereo = candidates.filter(function (stream) { return !isSurround(stream); });
        if (surround.length > 0) {
            tiers.push(pickBest(surround, isBetter));
        }
        if (stereo.length > 0) {
            tiers.push(pickBest(stereo, isBetter));
        }
        return tiers;
    };
    // A foreign film keeps its original-language audio in full - surround plus a
    // stereo mate - ahead of the English tracks, and flagged default. The Ensure
    // nodes only ever build English tracks, so this node builds the original's.
    var originalLang = originalAudioLanguage(args.originalLibraryFile);
    var originalAudio = originalLang && originalLang !== preferredLanguage
        ? audioStreams.filter(function (stream) { return languageOf(stream) === originalLang; })
        : [];
    var mainAudio = originalAudio.length > 0
        ? audioStreams.filter(function (stream) { return originalAudio.indexOf(stream) === -1; })
        : audioStreams;
    var keep = [];
    if (originalAudio.length > 0) {
        args.jobLog("Original audio language is ".concat(originalLang, "; keeping it first \n"));
        var encode = function (stream, channels, bitrate) {
            // eslint-disable-next-line no-param-reassign
            stream.outputArgs = encodeArgs(targetCodec, channels, bitrate);
            // eslint-disable-next-line no-param-reassign
            stream.codec_name = targetCodec;
            // eslint-disable-next-line no-param-reassign
            stream.channels = channels;
            args.variables.ffmpegCommand.shouldProcess = true;
            args.jobLog("Encoding ".concat(originalLang, " index ").concat(stream.index, " to ")
                .concat(targetCodec, " ").concat(channels, "ch @").concat(bitrate, " \n"));
        };
        var originalSurround = originalAudio.filter(isSurround);
        if (originalSurround.length > 0) {
            var surroundKeep = pickBest(originalSurround, isBetter);
            // Cloned before any args land on it, exactly as Ensure clones.
            var mateSource = JSON.parse(JSON.stringify(surroundKeep));
            var surroundChannels = Number(surroundKeep.channels || 0);
            if (surroundKeep.codec_name !== targetCodec || surroundChannels > EAC3_MAX_CHANNELS) {
                encode(surroundKeep, Math.min(surroundChannels, EAC3_MAX_CHANNELS), String(args.inputs.surroundBitrate));
            }
            keep.push(surroundKeep);
            var readyMates = originalAudio.filter(function (stream) {
                return Number(stream.channels || 0) === 2 && stream.codec_name === targetCodec;
            });
            if (readyMates.length > 0) {
                keep.push(pickBest(readyMates, isBetter));
            }
            else {
                var mate = mateSource;
                mate.index = streams.length;
                mate.removed = false;
                mate.outputArgs = [];
                mate.disposition = Object.assign({}, mate.disposition, { default: 0 });
                // Beside its source, not appended: Reorder Streams has already
                // grouped by type, so the end of the list is after the subtitles.
                streams.splice(streams.indexOf(surroundKeep) + 1, 0, mate);
                audioStreams.push(mate);
                encode(mate, 2, String(args.inputs.stereoBitrate));
                keep.push(mate);
            }
        }
        else {
            var stereoKeep = pickBest(originalAudio, isBetter);
            var stereoChannels = Math.min(Number(stereoKeep.channels || 0), 2);
            if (stereoKeep.codec_name !== targetCodec || Number(stereoKeep.channels || 0) !== stereoChannels) {
                encode(stereoKeep, stereoChannels, String(stereoChannels === 1
                    ? args.inputs.monoBitrate : args.inputs.stereoBitrate));
            }
            keep.push(stereoKeep);
        }
    }
    keep = keep.concat(pickTiers(mainAudio));
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
        var cleared = keep.slice(1).map(function (stream) { return "index ".concat(stream.index); });
        args.jobLog("Default audio flag set on index ".concat(keep[0].index, " and cleared on ")
            .concat(cleared.length > 0 ? cleared.join(', ') : 'nothing else', " \n"));
        // eslint-disable-next-line no-param-reassign
        args.variables.ffmpegCommand.shouldProcess = true;
    }
    // Put the kept tracks in the order chosen above: original language first,
    // then English, surround ahead of stereo within each. Execute maps streams in array order, and
    // players generally default to the first audio track, so this decides what
    // you actually hear. "Reorder Streams" cannot do it: its channel map only
    // knows 8/6/2/1, so a 4-channel track sorts as an empty string and lands
    // wherever it started. It runs before this node and groups by stream type
    // only, and its sort is stable, so the order set here is the one Execute
    // sees.
    // The kept tracks are dealt back into the slots they already occupy, so
    // video and subtitles never move.
    var slots = keep.map(function (stream) { return streams.indexOf(stream); })
        .sort(function (a, b) { return a - b; });
    var moved = keep.some(function (stream, i) { return streams[slots[i]] !== stream; });
    if (moved) {
        keep.forEach(function (stream, i) {
            streams[slots[i]] = stream;
        });
        args.jobLog('Reordered audio: '.concat(keep.map(describe).join(', '), " \n"));
        // eslint-disable-next-line no-param-reassign
        args.variables.ffmpegCommand.shouldProcess = true;
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
    //
    // This has to be the last node before Execute for the test to mean
    // anything. "Reorder Streams" sets shouldProcess itself when it moves a
    // stream, and it used to run after this one, so a rewrite triggered by a
    // reorder alone went out with ffmpeg's default "-avoid_negative_ts auto"
    // and the guard silently did not apply. Nothing downstream of here can set
    // the flag now: Execute's own additions are the removals this node already
    // accounts for.
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
