// Menu settings for the KB X3: labels and the values the camera accepts.
// Options were found by probing a real X3 (firmware "KBX3") with
// X3Camera.discoverOptions(); the camera answers 701 for anything else.
//   options  - accepted values ([value, label] pairs where the raw value is cryptic)
//   free     - editable, but options weren't probed; the camera still validates
//   readOnly - status values, or settings where only the current value is accepted

const onOff = [['OFF', 'Off'], ['ON', 'On']];

export const SETTINGS = {
  VideoRes: { label: 'Video resolution', options: ['2.7K30', '1080P60', '1080P30', '720P120', '720P60'] },
  ImageRes: { label: 'Photo resolution', options: ['12MP', '10MP', '8MP', '5MP', '3MP', '2MP'] },
  VideoClipTime: { label: 'Clip length', options: [['OFF', 'Off (one file)'], ['2MIN', '2 min'], ['3MIN', '3 min'], ['5MIN', '5 min']] },
  Timelapse: { label: 'Time-lapse', options: [['OFF', 'Off'], ['1SEC', '1 s'], ['5SEC', '5 s'], ['10SEC', '10 s'], ['30SEC', '30 s'], ['60SEC', '60 s']] },
  EV: {
    label: 'Exposure',
    options: [['EVN200', '-2.0'], ['EVN167', '-1.7'], ['EVN133', '-1.3'], ['EVN100', '-1.0'], ['EVN067', '-0.7'], ['EVN033', '-0.3'],
      ['EV0', '0'], ['EVP033', '+0.3'], ['EVP067', '+0.7'], ['EVP100', '+1.0'], ['EVP133', '+1.3'], ['EVP167', '+1.7'], ['EVP200', '+2.0']],
  },
  AWB: {
    label: 'White balance',
    options: [['AUTO', 'Auto'], ['DAYLIGHT', 'Daylight'], ['CLOUDY', 'Cloudy'], ['FLUORESCENT1', 'Fluorescent 1'],
      ['FLUORESCENT2', 'Fluorescent 2'], ['FLUORESCENT3', 'Fluorescent 3'], ['INCANDESCENT', 'Incandescent']],
  },
  HDR: { label: 'HDR', options: onOff },
  SpotMeter: { label: 'Spot metering', options: onOff },
  'Q-SHOT': { label: 'Quick shot', options: onOff },
  MTD: { label: 'Motion detection', options: [['OFF', 'Off'], ['HIGH', 'On']] },
  GSensor: { label: 'G-sensor', options: [['OFF', 'Off'], ['LEVEL0', 'Low'], ['LEVEL2', 'Medium'], ['LEVEL4', 'High']] },
  Flicker: { label: 'Flicker', options: ['50Hz', '60Hz'] },
  TVSystem: { label: 'TV system', options: ['PAL', 'NTSC'] },
  UpsideDown: { label: 'Orientation', options: [['Normal', 'Normal'], ['Upsidedown', 'Upside down']] },
  // These read back as "OF" when set to OFF.
  SoundIndicator: { label: 'Beeps', options: onOff, aliases: { OF: 'OFF' } },
  StatusLights: { label: 'Status lights', options: onOff, aliases: { OF: 'OFF' } },
  LCDPower: { label: 'Screen power', free: true },
  PowerOffDelay: { label: 'Auto power-off', free: true },
  PowerSaving: { label: 'Power saving', free: true },
  LoopingVideo: { label: 'Loop recording', readOnly: true },
  SlowMotion: { label: 'Slow motion', readOnly: true },
  PhotoBurst: { label: 'Photo burst', readOnly: true },
  FWversion: { label: 'Firmware', readOnly: true },
  SD0: { label: 'SD card', readOnly: true },
  UIMode: { label: 'Camera screen', readOnly: true },
  IsStreaming: { label: 'Streaming', readOnly: true },
  DefMode: { label: 'Default mode', readOnly: true },
  TV: { label: 'TV out', readOnly: true },
  Property: { label: 'Property', readOnly: true },
};

// Map a reported value to the option it stands for (e.g. "OF" -> "OFF").
export function normaliseValue(name, value) {
  const meta = SETTINGS[name];
  const aliased = meta?.aliases?.[value] ?? value;
  const match = meta?.options?.map((o) => (Array.isArray(o) ? o[0] : o))
    .find((o) => o.toLowerCase() === String(aliased).toLowerCase());
  return match ?? aliased;
}
