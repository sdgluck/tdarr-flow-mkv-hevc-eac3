/* eslint-disable */
const details = () => ({
  id: 'Tdarr_Plugin_bsh1_CleanAudio',
  Stage: 'Pre-processing',
  Name: 'Remove Non-English Audio (strip thumbnails)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Removes non-English and commentary audio streams. Uses explicit stream mapping to exclude attached pictures/thumbnails that cause MKV mux failures.',
  Version: '1.0.0',
  Tags: 'pre-processing,ffmpeg,audio',
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
      tooltip: 'Remove commentary audio tracks',
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

  const streams = file.ffProbeData?.streams ?? [];
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  const streamsToRemove = [];

  audioStreams.forEach(stream => {
    const lang = (stream.tags?.language || '').toLowerCase();
    const title = (stream.tags?.title || '').toLowerCase();
    const isCommentary = stream.disposition?.comment === 1 || title.includes('comment');

    let shouldRemove = false;

    if (lang && lang !== keepLang) {
      shouldRemove = true;
      response.infoLog += `☒ Removing audio stream ${stream.index} (lang: ${lang}).\n`;
    } else if (removeCommentary && isCommentary) {
      shouldRemove = true;
      response.infoLog += `☒ Removing commentary audio stream ${stream.index}.\n`;
    }

    if (shouldRemove) streamsToRemove.push(stream.index);
  });

  // Safety: never remove all audio tracks
  const keptAudio = audioStreams.filter(s => !streamsToRemove.includes(s.index));
  if (keptAudio.length === 0) {
    response.processFile = false;
    response.infoLog += '⚠ Skipping: removing all audio streams would leave no audio.\n';
    return response;
  }

  if (streamsToRemove.length === 0) {
    response.processFile = false;
    response.infoLog += '☑ No audio streams to remove.\n';
    return response;
  }

  // 0:V:0 (uppercase V) excludes attached pictures
  const excludeMaps = streamsToRemove.map(i => `-map -0:${i}`).join(' ');
  response.preset = `, -map 0:V:0 -map 0:a? -map 0:s? ${excludeMaps} -c copy -max_muxing_queue_size 9999`;
  response.processFile = true;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
