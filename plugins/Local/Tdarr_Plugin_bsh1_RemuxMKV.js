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
  const streams = file.ffProbeData?.streams ?? [];
  const subPlan = planSubtitles(streams);
  response.infoLog += subPlan.log;

  // -fflags +genpts: DivX-packed AVI (and some MPEG-PS) carry packets with no
  // timestamps. The matroska muxer rejects those outright ("Can't write packet
  // with unknown timestamp") and emits a truncated file, so the remux must
  // synthesise timestamps from the frame rate. Input-side flag, hence the
  // leading position before the comma that separates input and output args.
  response.preset = `-fflags +genpts, -map 0:V:0 -map 0:a? ${subPlan.args} -c copy `
    + '-max_muxing_queue_size 9999';

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
