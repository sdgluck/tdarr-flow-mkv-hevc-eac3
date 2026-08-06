/* eslint-disable */
const details = () => ({
  id: 'Tdarr_Plugin_bsh1_CleanSubs',
  Stage: 'Pre-processing',
  Name: 'Remove Non-English Subs (strip thumbnails)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Removes non-English subtitle streams and commentary/SDH subs. Uses explicit stream mapping to exclude attached pictures/thumbnails that cause MKV mux failures.',
  Version: '1.0.0',
  Tags: 'pre-processing,ffmpeg,subtitles',
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
      tooltip: 'Remove commentary subtitle tracks',
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

  // Find subtitle streams to remove
  const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');
  const streamsToRemove = [];

  subtitleStreams.forEach(stream => {
    const lang = (stream.tags?.language || '').toLowerCase();
    const title = (stream.tags?.title || '').toLowerCase();
    // SDH is signalled either by the disposition flag or by the title alone;
    // it is deliberately NOT treated as commentary, so remove_sdh governs it.
    const isSDH = stream.disposition?.hearing_impaired === 1 || title.includes('sdh');
    const isCommentary = stream.disposition?.comment === 1 || title.includes('comment');

    let shouldRemove = false;

    if (lang && lang !== keepLang) {
      shouldRemove = true;
      response.infoLog += `☒ Removing subtitle stream ${stream.index} (lang: ${lang}).\n`;
    } else if (removeCommentary && isCommentary) {
      shouldRemove = true;
      response.infoLog += `☒ Removing commentary subtitle stream ${stream.index}.\n`;
    } else if (removeSDH && isSDH) {
      shouldRemove = true;
      response.infoLog += `☒ Removing SDH subtitle stream ${stream.index}.\n`;
    }

    if (shouldRemove) streamsToRemove.push(stream.index);
  });

  if (streamsToRemove.length === 0) {
    response.processFile = false;
    response.infoLog += '☑ No subtitle streams to remove.\n';
    return response;
  }

  // Build map args:
  // - 0:V:0  = first real video only (uppercase V excludes attached pics)
  // - 0:a?   = all audio
  // - 0:s?   = all subs, then explicitly exclude the ones to remove
  const excludeMaps = streamsToRemove.map(i => `-map -0:${i}`).join(' ');
  response.preset = `-analyzeduration 100M -probesize 100M, -map 0:V:0 -map 0:a? -map 0:s? ${excludeMaps} -c:v copy -c:a copy -c:s copy -max_muxing_queue_size 9999`;
  response.processFile = true;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
