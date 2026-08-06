/* eslint-disable */
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
  // mov_text (tx3g) is MP4-only and unsupported in MKV - drop those subs
  const streams = file.ffProbeData?.streams ?? [];
  const hasMovText = streams.some(s => s.codec_type === 'subtitle' && s.codec_name === 'mov_text');
  const subMap = hasMovText ? '' : '-map 0:s?';

  if (hasMovText) {
    response.infoLog += '☒ Dropping mov_text subtitles (MP4-only, incompatible with MKV).\n';
  }

  response.preset = `${inputArgs}, -map 0:V:0 -map 0:a? ${subMap} -c copy `
    + '-max_muxing_queue_size 9999 -avoid_negative_ts make_zero';

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
