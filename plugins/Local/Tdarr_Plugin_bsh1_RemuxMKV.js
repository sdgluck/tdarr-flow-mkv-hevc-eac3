/* eslint-disable */
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
  id: 'Tdarr_Plugin_bsh1_RemuxMKV',
  Stage: 'Pre-processing',
  Name: 'Remux to MKV (strip thumbnails)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Remuxes file to MKV, stripping embedded thumbnails/attached pictures, '
    + 'incompatible mov_text subtitles, and subtitle streams ffmpeg cannot decode. An MKV is '
    + 'passed through untouched unless it carries one of those undecodable streams.',
  Version: '1.2.0',
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

  const streams = file.ffProbeData?.streams ?? [];
  const unreadableSubs = streams.filter(isUnreadableSub);

  // An MKV needs no remux - unless it carries a stream that fails every later
  // command. This node is the flow's first ffmpeg stop, so healing the file
  // here is what lets the encode, the track clean-up and the final mux run at
  // all; leave it and each of them dies in turn on the same header error.
  if (file.container === 'mkv') {
    if (unreadableSubs.length === 0) {
      response.processFile = false;
      response.infoLog += '☑ File is already MKV, skipping.\n';
      return response;
    }

    response.processFile = true;
    response.infoLog += unreadableLog(unreadableSubs.length);
    const excludeMaps = unreadableSubs.map(s => `-map -0:${s.index}`).join(' ');
    response.preset = '-analyzeduration 100M -probesize 100M, -map 0:V:0 -map 0:a? -map 0:s? '
      + `${excludeMaps} -map 0:t? -c copy -max_muxing_queue_size 9999`;
    return response;
  }

  response.processFile = true;
  response.infoLog += `☒ File is ${file.container}, remuxing to MKV and stripping thumbnails.\n`;

  // 0:V:0 (uppercase V) selects only the first real video stream, excluding attached pictures
  const subPlan = planSubtitles(streams);
  response.infoLog += subPlan.log;

  // -fflags +genpts: DivX-packed AVI (and some MPEG-PS) carry packets with no
  // timestamps. The matroska muxer rejects those outright ("Can't write packet
  // with unknown timestamp") and emits a truncated file, so the remux must
  // synthesise timestamps from the frame rate. Input-side flag, hence the
  // leading position before the comma that separates input and output args.
// Font attachments. An ASS/SSA subtitle names the fonts it wants and Matroska
// carries them alongside as attachment streams; "-map 0:s?" does not select
// those, so a remux that lists its maps explicitly silently drops them and the
// subtitle renders in whatever the player substitutes. "?" so a file with none
// is not an error. Attached-picture cover art is a video stream, not an
// attachment, so this does not undo the thumbnail stripping above.
  // "-c copy" carries no stream specifier, so it matches every output stream -
  // and ffmpeg resolves a per-stream option by taking the LAST instance that
  // matches. A "-c:s:N srt" placed before it is therefore overridden, the
  // mov_text track is stream-copied into Matroska after all, and the mux dies
  // at the header on the very error the conversion exists to avoid. The
  // general codec has to come first and the specific override last.
  response.preset = ['-fflags +genpts,', '-map 0:V:0', '-map 0:a?', subPlan.maps,
    '-map 0:t?', '-c copy', subPlan.codecs, '-max_muxing_queue_size 9999']
    .filter(part => part !== '')
    .join(' ');

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
