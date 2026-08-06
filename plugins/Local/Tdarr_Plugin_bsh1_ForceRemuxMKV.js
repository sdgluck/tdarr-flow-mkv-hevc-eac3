/* eslint-disable */
const details = () => ({
  id: 'Tdarr_Plugin_bsh1_ForceRemuxMKV',
  Stage: 'Pre-processing',
  Name: 'Force Remux MKV (repair container)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Force remuxes an MKV to repair container corruption. Use on the error path of runMkvPropEdit to fix files that fail stats tagging due to structural corruption.',
  Version: '1.0.0',
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

  if (file.container !== 'mkv') {
    response.processFile = false;
    response.infoLog += `☑ File is ${file.container}, not MKV - skipping force remux.\n`;
    return response;
  }

  response.processFile = true;
  response.infoLog += '☒ Force remuxing MKV to repair container structure.\n';

  // 0:V:0 (uppercase V) excludes attached pictures
  response.preset = ', -map 0:V:0 -map 0:a? -map 0:s? -c copy -max_muxing_queue_size 9999';

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
