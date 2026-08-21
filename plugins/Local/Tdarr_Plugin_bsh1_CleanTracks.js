/* eslint-disable */
const details = () => ({
  id: 'Tdarr_Plugin_bsh1_CleanTracks',
  Stage: 'Pre-processing',
  Name: 'Remove Non-English Audio and Subtitles',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Removes non-English audio and subtitle streams, and commentary tracks, in a '
    + 'single pass. Replaces the separate CleanAudio/CleanSubs plugins, which each did a full '
    + 'read-and-rewrite of the file.',
  Version: '1.0.0',
  Tags: 'pre-processing,ffmpeg,audio,subtitles',
  Inputs: [
    {
      name: 'tag_language',
      type: 'string',
      defaultValue: 'eng',
      inputUI: { type: 'text' },
      tooltip: 'Language tag to keep (e.g. eng)',
    },
    {
      name: 'remove_commentary',
      type: 'boolean',
      defaultValue: true,
      inputUI: { type: 'switch' },
      tooltip: 'Remove commentary audio and subtitle tracks',
    },
    {
      name: 'remove_sdh',
      type: 'boolean',
      defaultValue: false,
      inputUI: { type: 'switch' },
      tooltip: 'Remove SDH (hearing impaired) subtitle tracks',
    },
  ],
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
    container: `.${file.container}`,
  };

  const keepLang = (inputs.tag_language || 'eng').trim().toLowerCase();
  const removeCommentary = inputs.remove_commentary === true || inputs.remove_commentary === 'true';
  const removeSDH = inputs.remove_sdh === true || inputs.remove_sdh === 'true';

  const streams = file.ffProbeData?.streams ?? [];
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');

  const audioToRemove = [];
  const subsToRemove = [];

  audioStreams.forEach(stream => {
    const lang = (stream.tags?.language || '').toLowerCase();
    const title = (stream.tags?.title || '').toLowerCase();
    const isCommentary = stream.disposition?.comment === 1 || title.includes('comment');

    // Streams with no language tag are kept: an untagged track is far more
    // often the main one than a foreign one.
    if (lang && lang !== keepLang) {
      audioToRemove.push(stream.index);
      response.infoLog += `☒ Removing audio stream ${stream.index} (lang: ${lang}).\n`;
    } else if (removeCommentary && isCommentary) {
      audioToRemove.push(stream.index);
      response.infoLog += `☒ Removing commentary audio stream ${stream.index}.\n`;
    }
  });

  // Safety: never remove all audio tracks. Better a foreign track than a silent
  // file - and an empty audio map is worse than either.
  const keptAudio = audioStreams.filter(s => !audioToRemove.includes(s.index));
  if (audioStreams.length > 0 && keptAudio.length === 0) {
    audioToRemove.length = 0;
    response.infoLog += '⚠ Keeping all audio: removing them would leave no audio.\n';
  }

  subtitleStreams.forEach(stream => {
    const lang = (stream.tags?.language || '').toLowerCase();
    const title = (stream.tags?.title || '').toLowerCase();
    // SDH is signalled either by the disposition flag or by the title alone;
    // it is deliberately NOT treated as commentary, so remove_sdh governs it.
    const isSDH = stream.disposition?.hearing_impaired === 1 || title.includes('sdh');
    const isCommentary = stream.disposition?.comment === 1 || title.includes('comment');

    if (lang && lang !== keepLang) {
      subsToRemove.push(stream.index);
      response.infoLog += `☒ Removing subtitle stream ${stream.index} (lang: ${lang}).\n`;
    } else if (removeCommentary && isCommentary) {
      subsToRemove.push(stream.index);
      response.infoLog += `☒ Removing commentary subtitle stream ${stream.index}.\n`;
    } else if (removeSDH && isSDH) {
      subsToRemove.push(stream.index);
      response.infoLog += `☒ Removing SDH subtitle stream ${stream.index}.\n`;
    }
  });

  // Exactly one subtitle track survives. Two English text tracks are
  // indistinguishable to a player whenever the source flags neither: Show B
  // S03E08 labelled its SDH track in the title only, so both came out as plain
  // eng/subrip and Plex's subtitle selector matched both. Its SRT output cannot
  // represent that -- "srt muxer does not support more than one stream of type
  // subtitle" -- and the session dies with "Conversion failed". One track makes
  // that impossible for any selector, not just the one Plex happened to use.
  //
  // Collapsing here is free: this pass is already a stream copy over the file.
  const keptSubs = subtitleStreams.filter(s => !subsToRemove.includes(s.index));
  if (keptSubs.length > 1) {
    // A forced track carries foreign dialogue only, so it is the worst possible
    // sole subtitle. SDH is a full transcript and merely noisy. Lower is better;
    // ties fall through to the earlier stream in the file.
    const rank = stream => {
      const title = (stream.tags?.title || '').toLowerCase();
      const isSDH = stream.disposition?.hearing_impaired === 1 || title.includes('sdh');
      const isForced = stream.disposition?.forced === 1 || title.includes('forced');
      return (isForced ? 2 : 0) + (isSDH ? 1 : 0);
    };
    let best = keptSubs[0];
    keptSubs.forEach(stream => {
      if (rank(stream) < rank(best)) best = stream;
    });
    keptSubs.forEach(stream => {
      if (stream.index === best.index) return;
      subsToRemove.push(stream.index);
      response.infoLog += `☒ Removing surplus subtitle stream ${stream.index}; `
        + `keeping ${best.index} as the only subtitle track.\n`;
    });
  }

  const streamsToRemove = audioToRemove.concat(subsToRemove);
  if (streamsToRemove.length === 0) {
    response.processFile = false;
    response.infoLog += '☑ No audio or subtitle streams to remove.\n';
    return response;
  }

  // - 0:V:0 = first real video only (uppercase V excludes attached pictures)
  // - then all audio and subs, with the unwanted ones explicitly excluded
  const excludeMaps = streamsToRemove.map(i => `-map -0:${i}`).join(' ');
  response.preset = `-analyzeduration 100M -probesize 100M, -map 0:V:0 -map 0:a? -map 0:s? `
    + `${excludeMaps} -c copy -max_muxing_queue_size 9999`;
  response.processFile = true;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
