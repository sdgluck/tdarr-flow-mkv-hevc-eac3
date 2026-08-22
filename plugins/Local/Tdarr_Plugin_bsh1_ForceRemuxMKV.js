/* eslint-disable */
// mov_text (tx3g) is MP4-only: Matroska cannot carry it. Dropping every
// subtitle the moment one appeared - which is what this used to do - threw away
// perfectly good SRT tracks standing beside it. Keep everything MKV can hold,
// and convert mov_text to SRT only when nothing else already carries the
// dialogue as text. Text to text, so nothing is lost.
const TEXT_SUB_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'text', 'mov_text'];

const planSubtitles = (streams) => {
  const subs = streams.filter(s => s.codec_type === 'subtitle');
  if (subs.length === 0) {
    return { args: '', log: '' };
  }

  const movText = subs.filter(s => s.codec_name === 'mov_text');
  if (movText.length === 0) {
    return { args: '-map 0:s?', log: '' };
  }

  // Another text track already carries the dialogue, so the mov_text one adds
  // nothing worth a conversion.
  const hasOtherText = subs.some(s => s.codec_name !== 'mov_text'
    && TEXT_SUB_CODECS.includes(s.codec_name));
  const kept = hasOtherText ? subs.filter(s => s.codec_name !== 'mov_text') : subs;

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

  return { args: [...mapArgs, ...codecArgs].join(' '), log };
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

  response.preset = `${inputArgs}, -map 0:V:0 -map 0:a? ${subPlan.args} -c copy `
    + '-max_muxing_queue_size 9999 -avoid_negative_ts make_zero';

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
