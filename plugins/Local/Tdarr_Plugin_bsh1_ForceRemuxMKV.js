/* eslint-disable */
// The subtitle planning below is a deliberate copy of RemuxMKV's: each classic
// plugin is deployed to the server as a standalone file, so there is nowhere to
// share it from. It drifted once already - this copy kept the pre-1.2.0 version
// with no unreadable-stream filter, which mattered precisely here, since this
// plugin only ever runs on a file a normal remux could not handle. Change both.
// mov_text (tx3g) is MP4-only: Matroska cannot carry it. Dropping every
// subtitle the moment one appeared - which is what this used to do - threw away
// perfectly good SRT tracks standing beside it. Keep everything MKV can hold,
// and convert mov_text to SRT only when nothing else already carries the
// dialogue as text. Text to text, so nothing is lost.
const TEXT_SUB_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'text', 'mov_text'];

// A subtitle stream this ffmpeg build cannot identify. Matroska may carry a
// CodecID the demuxer has no decoder for - WebVTT (S_TEXT/WEBVTT) is the one
// seen in the wild:
//
//   [matroska,webm] Unknown/unsupported AVCodecID S_TEXT/WEBVTT.
//   [matroska,webm] Could not find codec parameters for stream 4
//                   (Subtitle: none): unknown codec
//
// The stream then arrives with codec id 0, and mapping it - even with "-c
// copy" - kills the whole command at the header, taking the video with it:
//
//   [matroska] Subtitle codec 0 is not supported.
//   [out#0/matroska] Could not write header (incorrect codec parameters ?)
//
// So this is not "a subtitle we would rather not keep", it is a stream nothing
// downstream can touch. Drop it here, before any later stage maps it.
const isUnreadableSub = (stream) => stream.codec_type === 'subtitle'
  && (!stream.codec_name || stream.codec_name === 'none' || stream.codec_name === 'unknown');

const unreadableLog = (count) => `\u2612 Dropping ${count} unreadable subtitle stream(s); `
  + 'ffmpeg reports no codec for them and mapping one fails the whole command.\n';

const planSubtitles = (streams) => {
  const subs = streams.filter(s => s.codec_type === 'subtitle');
  if (subs.length === 0) {
    return { maps: '', codecs: '', log: '' };
  }

  const unreadable = subs.filter(isUnreadableSub);
  const readable = subs.filter(s => !isUnreadableSub(s));
  const unreadableArgs = unreadable.map(s => `-map -0:${s.index}`);
  const unreadableInfo = unreadable.length > 0 ? unreadableLog(unreadable.length) : '';

  const movText = readable.filter(s => s.codec_name === 'mov_text');
  if (movText.length === 0) {
    return {
      maps: ['-map 0:s?', ...unreadableArgs].join(' '),
      codecs: '',
      log: unreadableInfo,
    };
  }

  // Another text track already carries the dialogue, so the mov_text one adds
  // nothing worth a conversion.
  const hasOtherText = readable.some(s => s.codec_name !== 'mov_text'
    && TEXT_SUB_CODECS.includes(s.codec_name));
  const kept = hasOtherText ? readable.filter(s => s.codec_name !== 'mov_text') : readable;

  // Mapped one by one rather than with "0:s?", because "-c:s:N" counts N among
  // the subtitle OUTPUT streams: the conversion has to name the right one.
  const mapArgs = [];
  const codecArgs = [];
  kept.forEach((stream, n) => {
    mapArgs.push(`-map 0:${stream.index}`);
    if (stream.codec_name === 'mov_text') {
      codecArgs.push(`-c:s:${n} srt`);
    }
  });

  const log = hasOtherText
    ? `\u2612 Dropping ${movText.length} mov_text subtitle(s); MKV cannot carry them and `
      + 'other text subtitles remain.\n'
    : `\u2612 Converting ${movText.length} mov_text subtitle(s) to SRT; MKV cannot carry mov_text.\n`;

  // The kept streams are mapped one by one here, so an unreadable one is
  // excluded simply by never being named.
  //
  // Maps and codec overrides are handed back separately because they have to
  // straddle the "-c copy": see the preset below.
  return {
    maps: mapArgs.join(' '),
    codecs: codecArgs.join(' '),
    log: unreadableInfo + log,
  };
};

const details = () => ({
  id: 'Tdarr_Plugin_bsh1_ForceRemuxMKV',
  Stage: 'Pre-processing',
  Name: 'Force Remux MKV (repair container)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Last-resort remux to MKV from any container, using permissive demuxer flags. Escalation for files that fail a normal remux, and a repair for structurally broken MKVs that fail stats tagging.',
  Version: '2.0.0',
  Tags: 'pre-processing,ffmpeg,remux,mkv,repair',
  Inputs: [],
});

const plugin = (file, librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  inputs = lib.loadDefaultValues(inputs, details);

  const response = {
    processFile: false,
    preset: '',
    handBrakeMode: false,
    FFmpegMode: true,
    reQueueAfter: true,
    infoLog: '',
    container: '.mkv',
  };

  // This runs only after a normal remux has already failed, so it must accept
  // ANY container. It previously bailed out on anything that was not already
  // MKV, which made it a no-op precisely when a container conversion needed
  // healing - the file carried on in its original container with nothing having
  // repaired it.
  response.processFile = true;
  response.infoLog += file.container === 'mkv'
    ? '☒ Force remuxing MKV to repair container structure.\n'
    : `☒ Force remuxing ${file.container} to MKV after a failed normal remux.\n`;

  // Escalation over RemuxMKV, which already tries -fflags +genpts. Re-running
  // the same command would fail identically, so this attempt is deliberately
  // more permissive on the demuxer side:
  //   genpts+igndts  synthesise timestamps and disregard broken input DTS
  //   analyzeduration/probesize  give ffmpeg far more data before it decides
  //                              stream layout, for sources it mis-detects
  //   err_detect ignore_err  push past corrupt packets rather than aborting
  //   avoid_negative_ts make_zero  shift negative start times the muxer rejects
  // Still a pure stream copy, so nothing is re-encoded and nothing is lost.
  const inputArgs = '-fflags +genpts+igndts -analyzeduration 200M -probesize 200M '
    + '-err_detect ignore_err';

  // 0:V:0 (uppercase V) excludes attached pictures
  const streams = file.ffProbeData?.streams ?? [];
  const subPlan = planSubtitles(streams);
  response.infoLog += subPlan.log;

  // "-c copy" matches every output stream and ffmpeg takes the LAST matching
  // instance of a per-stream option, so a "-c:s:N srt" before it is silently
  // overridden and the mov_text track is copied into Matroska after all.
  // General codec first, specific override last.
  response.preset = [`${inputArgs},`, '-map 0:V:0', '-map 0:a?', subPlan.maps,
    '-c copy', subPlan.codecs, '-max_muxing_queue_size 9999',
    '-avoid_negative_ts make_zero']
    .filter(part => part !== '')
    .join(' ');

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
