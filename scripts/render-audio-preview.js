#!/usr/bin/env node
'use strict';
/* Offline composition preview, not a substitute for browser/device playback QA.
   Shares oscillator score, envelope and output level with game-audio.js. */
const fs = require('node:fs');
const path = require('node:path');
const Audio = require('../game-audio.js');

const SAMPLE_RATE = 44100;
const DURATION = 12;
const CUES = Object.freeze([
  {at:0.20,kind:'ui',label:'Soft UI tap'},
  {at:0.55,kind:'countdown',label:'Countdown 3'},
  {at:1.00,kind:'countdown',label:'Countdown 2'},
  {at:1.45,kind:'countdown',label:'Countdown 1'},
  {at:1.90,kind:'start',label:'Start: find the cats'},
  {at:2.50,kind:'found',label:'Found cat: musical meow / chirp'},
  {at:3.05,kind:'combo',combo:2,label:'Second consecutive cat'},
  {at:3.55,kind:'combo',combo:5,label:'Fifth consecutive cat'},
  {at:4.05,kind:'launch',label:'Paw attack launch'},
  {at:4.50,kind:'impact',label:'Paw impact'},
  {at:4.95,kind:'damage',label:'Receiving damage'},
  {at:5.45,kind:'miss',label:'Wrong guess'},
  {at:6.00,kind:'lock',label:'Short guess lock'},
  {at:6.40,kind:'unlock',label:'Ready to guess again'},
  {at:6.90,kind:'boardClear',label:'Six cats found'},
  {at:7.70,kind:'newBoard',label:'Fresh board'},
  {at:8.30,kind:'win',label:'Friendly victory flourish'},
  {at:9.80,kind:'lose',label:'Gentle try-again phrase'},
  {at:10.70,kind:'ui',label:'Soft UI tap'}
]);

function envelopeAt(points,time) {
  if (time <= points[0].time) return points[0].value;
  for (let i=1; i<points.length; i++) {
    if (time <= points[i].time) {
      const a=points[i-1],b=points[i];
      return a.value + (b.value-a.value) * (time-a.time) / (b.time-a.time);
    }
  }
  return points.at(-1).value;
}
function phaseAt(points,time) {
  // Exact integral of the engine's piecewise-linear pitch glides, in cycles.
  let cycles = 0;
  for (let i=1; i<points.length; i++) {
    const a=points[i-1],b=points[i];
    const elapsed=Math.max(0,Math.min(time,b.time)-a.time);
    cycles += a.value*elapsed + (b.value-a.value)*elapsed*elapsed/(2*(b.time-a.time));
    if (time <= b.time) return cycles;
  }
  return cycles + Math.max(0,time-points.at(-1).time)*points.at(-1).value;
}
function render(cues=CUES,duration=DURATION,volume=Audio.constants.DEFAULT_VOLUME) {
  const samples = new Float64Array(Math.ceil(duration*SAMPLE_RATE));
  for (const cue of cues) {
    for (const note of Audio.score(cue.kind,{combo:cue.combo})) {
      const start = cue.at + note.when;
      const first = Math.ceil(start*SAMPLE_RATE);
      const end = Math.min(samples.length,Math.ceil((start+note.duration)*SAMPLE_RATE));
      for (let i=first; i<end; i++) {
        const t = i/SAMPLE_RATE-start;
        const sine = Math.sin(2*Math.PI*phaseAt(note.frequency,t));
        const wave = note.wave === 'triangle' ? 2/Math.PI*Math.asin(sine) : sine;
        samples[i] += wave * envelopeAt(note.envelope,t);
      }
    }
  }
  let peak=0,energy=0;
  for (let i=0; i<samples.length; i++) {
    samples[i] = Audio.softLimit(samples[i] * volume * Audio.constants.MASTER_GAIN);
    peak = Math.max(peak,Math.abs(samples[i])); energy += samples[i]*samples[i];
  }
  return {samples,peak,rms:Math.sqrt(energy/samples.length)};
}
function wav(samples) {
  const bytes = samples.length*2;
  const buffer = Buffer.alloc(44+bytes);
  buffer.write('RIFF',0); buffer.writeUInt32LE(36+bytes,4); buffer.write('WAVE',8);
  buffer.write('fmt ',12); buffer.writeUInt32LE(16,16); buffer.writeUInt16LE(1,20);
  buffer.writeUInt16LE(1,22); buffer.writeUInt32LE(SAMPLE_RATE,24);
  buffer.writeUInt32LE(SAMPLE_RATE*2,28); buffer.writeUInt16LE(2,32);
  buffer.writeUInt16LE(16,34); buffer.write('data',36); buffer.writeUInt32LE(bytes,40);
  for (let i=0; i<samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);
  return buffer;
}
function save(destination) {
  const result = render();
  const output = path.resolve(destination || path.join(__dirname,'../../cat-battle-deliverables/cat-audio-preview.wav'));
  fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,wav(result.samples));
  const readme=output.replace(/\.wav$/i,'')+'-README.txt';
  fs.writeFileSync(readme,[
    'CAT BATTLE: ORIGINAL SOUND PALETTE',
    '12 seconds / mono / 44.1 kHz / 16-bit PCM',
    '',
    'Original sine/triangle synthesis composed for this game. No outside audio assets.',
    'This offline preview uses the exact exported CatAudio.score() note, pitch-glide,',
    'envelope, default volume (45%), master gain and soft-limiter parameters.',
    'Cues are spaced apart for review; gameplay timing is intentionally different.',
    'No loudness normalization has been applied. Start listening at a comfortable level.',
    '',
    'This verifies generated PCM and note parameters, not autoplay unlock, browser',
    'mixing, Bluetooth latency, speaker balance or actual-device playback. The simple',
    'offline triangle oscillator is not a browser-specific band-limited implementation.',
    '',
    ...CUES.map(cue => `${cue.at.toFixed(2).padStart(5)} s  ${cue.label} [${cue.kind}${cue.combo ? ', combo '+cue.combo : ''}]`),
    '',
    `Peak: ${(20*Math.log10(result.peak)).toFixed(2)} dBFS; RMS: ${(20*Math.log10(result.rms)).toFixed(2)} dBFS.`,
    'No full-scale samples. Silence is included between cues and after the final tap.',
    '',
    'Recreate locally: node scripts/render-audio-preview.js [output.wav]',
    ''
  ].join('\n'));
  return {output,readme,duration:DURATION,sampleRate:SAMPLE_RATE,peak:result.peak,rms:result.rms,cues:CUES.length};
}
if (require.main === module) console.log(JSON.stringify(save(process.argv[2]),null,2));
module.exports = {CUES,DURATION,SAMPLE_RATE,envelopeAt,phaseAt,render,wav,save};
