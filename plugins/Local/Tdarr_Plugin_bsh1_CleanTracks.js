/* eslint-disable */
// Audio description narrates over the mix for blind viewers, and it is tagged
// with the film's own language, so the language pass keeps it. Left in, a later
// stage can pick it: Show A S01E03 built its only stereo track from one.
//
// An MP4 hands ffmpeg no title for its tracks at all - ffprobe reports only the
// language - and the names survive solely in ExifTool's Track<N>Name and
// MediaInfo's Title. A remux to MKV throws both away, so the remux has to act on
// them; by the time CleanTracks runs the track looks like any other.
const DESCRIPTION_TITLE = /descri(ption|ptive)|visually impaired/i;

const isDescriptionAudio = (stream, file) => {
  if (stream.disposition?.visual_impaired === 1 || stream.disposition?.descriptions === 1) {
    return true;
  }
  const mediaInfoTrack = (file.mediaInfo?.track ?? [])
    .find(track => Number(track.StreamOrder) === stream.index);
  return [stream.tags?.title, mediaInfoTrack?.Title, file.meta?.[`Track${stream.index + 1}Name`]]
    .some(title => DESCRIPTION_TITLE.test(title || ''));
};

const details = () => ({
  id: 'Tdarr_Plugin_bsh1_CleanTracks',
  Stage: 'Pre-processing',
  Name: 'Remove Non-English Audio and Subtitles',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Removes non-English audio and subtitle streams, commentary and audio description tracks, '
    + 'in a single pass, along with any subtitle ffmpeg cannot decode. Replaces the separate '
    + 'CleanAudio/CleanSubs plugins, which each did a full read-and-rewrite of the file.',
  Version: '1.2.0',
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
    } else if (removeCommentary && isDescriptionAudio(stream, file)) {
      audioToRemove.push(stream.index);
      response.infoLog += `☒ Removing audio description stream ${stream.index}.\n`;
    }
  });

  // Safety: never remove all audio tracks. Better a foreign track than a silent
  // file - and an empty audio map is worse than either.
  const keptAudio = audioStreams.filter(s => !audioToRemove.includes(s.index));
  if (audioStreams.length > 0 && keptAudio.length === 0) {
    audioToRemove.length = 0;
    response.infoLog += '⚠ Keeping all audio: removing them would leave no audio.\n';
  }

  // A subtitle ffmpeg cannot identify - Matroska WebVTT is the case seen in the
  // wild - arrives with codec id 0, and mapping it fails the whole command at
  // the header ("Subtitle codec 0 is not supported"), taking the video with it.
  // The remux node strips these first; this is the backstop for a file that
  // reaches here with one anyway.
  const isUnreadable = stream => !stream.codec_name
    || stream.codec_name === 'none'
    || stream.codec_name === 'unknown';

  subtitleStreams.forEach(stream => {
    const lang = (stream.tags?.language || '').toLowerCase();
    const title = (stream.tags?.title || '').toLowerCase();
    // SDH is signalled either by the disposition flag or by the title alone;
    // it is deliberately NOT treated as commentary, so remove_sdh governs it.
    const isSDH = stream.disposition?.hearing_impaired === 1 || title.includes('sdh');
    const isCommentary = stream.disposition?.comment === 1 || title.includes('comment');

    if (isUnreadable(stream)) {
      subsToRemove.push(stream.index);
      response.infoLog += `☒ Removing subtitle stream ${stream.index}; ffmpeg reports no `
        + 'codec for it and mapping it fails the whole command.\n';
    } else if (lang && lang !== keepLang) {
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
    // Lower is better; ties fall through to the earlier stream in the file.
    //
    //   forced  worst: it carries foreign dialogue only, so as the SOLE track it
    //           leaves most of the dialogue uncovered.
    //   image   complete, but PGS/VOBSUB cannot be handed to a client as text,
    //           so Plex must burn it into the video - a full transcode, which is
    //           the session that was failing in the first place.
    //   SDH     complete and text; merely noisy.
    const IMAGE_SUB_CODECS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
    const rank = stream => {
      const title = (stream.tags?.title || '').toLowerCase();
      const isSDH = stream.disposition?.hearing_impaired === 1 || title.includes('sdh');
      const isForced = stream.disposition?.forced === 1 || title.includes('forced');
      const isImage = IMAGE_SUB_CODECS.includes(stream.codec_name);
      return (isForced ? 4 : 0) + (isImage ? 2 : 0) + (isSDH ? 1 : 0);
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
  // - 0:t? = font attachments, which an ASS subtitle needs to render as authored
  //   and which "-map 0:s?" does not select. Only into a container that can hold
  //   them: this plugin keeps whatever container it was handed, and reaches a
  //   non-MKV one only when both remux attempts failed.
  const excludeMaps = streamsToRemove.map(i => `-map -0:${i}`).join(' ');
  const attachmentMap = file.container === 'mkv' ? ' -map 0:t?' : '';
  response.preset = `-analyzeduration 100M -probesize 100M, -map 0:V:0 -map 0:a? -map 0:s? `
    + `${excludeMaps}${attachmentMap} -c copy -max_muxing_queue_size 9999`;
  response.processFile = true;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
