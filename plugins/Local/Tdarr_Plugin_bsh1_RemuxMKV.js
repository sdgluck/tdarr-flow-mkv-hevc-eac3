/* eslint-disable */
const details = () => ({
  id: 'Tdarr_Plugin_bsh1_RemuxMKV',
  Stage: 'Pre-processing',
  Name: 'Remux to MKV (strip thumbnails)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Remuxes file to MKV, stripping embedded thumbnails/attached pictures and incompatible mov_text subtitles.',
  Version: '1.1.0',
  Tags: 'pre-processing,ffmpeg,remux,mkv',
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

  // Skip if already MKV
  if (file.container === 'mkv') {
    response.processFile = false;
    response.infoLog += '☑ File is already MKV, skipping.\n';
    return response;
  }

  response.processFile = true;
  response.infoLog += `☒ File is ${file.container}, remuxing to MKV and stripping thumbnails.\n`;

  // 0:V:0 (uppercase V) selects only the first real video stream, excluding attached pictures
  // mov_text (tx3g) is MP4-only and unsupported in MKV - drop those subs
  const streams = file.ffProbeData?.streams ?? [];
  const hasMovText = streams.some(s => s.codec_type === 'subtitle' && s.codec_name === 'mov_text');
  const subMap = hasMovText ? '' : '-map 0:s?';

  if (hasMovText) {
    response.infoLog += '☒ Dropping mov_text subtitles (MP4-only, incompatible with MKV).\n';
  }

  // -fflags +genpts: DivX-packed AVI (and some MPEG-PS) carry packets with no
  // timestamps. The matroska muxer rejects those outright ("Can't write packet
  // with unknown timestamp") and emits a truncated file, so the remux must
  // synthesise timestamps from the frame rate. Input-side flag, hence the
  // leading position before the comma that separates input and output args.
  response.preset = `-fflags +genpts, -map 0:V:0 -map 0:a? ${subMap} -c copy -max_muxing_queue_size 9999`.trimEnd();

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
