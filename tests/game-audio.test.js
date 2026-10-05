'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Audio = require('../game-audio.js');

class Param {
  constructor(value=0) { this.value = value; this.calls = []; }
  setValueAtTime(value,time) { this.calls.push(['set',value,time]); this.value = value; }
  linearRampToValueAtTime(value,time) { this.calls.push(['ramp',value,time]); this.value = value; }
  setTargetAtTime(value,time,constant) { this.calls.push(['target',value,time,constant]); this.value = value; }
  cancelScheduledValues(time) { this.calls.push(['cancel',time]); }
}
class Node {
  constructor(context) { this.context = context; this.connections = []; this.disconnected = false; }
  connect(node) { assert.ok(node); this.connections.push(node); }
  disconnect() { this.disconnected = true; }
}
class Oscillator extends Node {
  constructor(context) { super(context); this.frequency = new Param(); this.stops = []; this.active = false; }
  start(time) { this.startAt = time; this.active = true; this.context.maxScheduled = Math.max(this.context.maxScheduled,this.context.oscillators.filter(o => o.active).length); }
  stop(time) { this.stops.push(time); if (time <= this.context.currentTime) this.active = false; }
  finish() { this.active = false; if (this.onended) this.onended(); }
}
class Context {
  constructor(state='running') { this.state = state; this.currentTime = 10; this.destination = {}; this.oscillators = []; this.gains = []; this.resumes = 0; this.maxScheduled = 0; }
  createGain() { const node = new Node(this); node.gain = new Param(1); this.gains.push(node); return node; }
  createOscillator() { const node = new Oscillator(this); this.oscillators.push(node); return node; }
  createWaveShaper() { this.limiter = new Node(this); return this.limiter; }
  addEventListener(event,callback) { this[event] = callback; }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  changeState(state) { this.state = state; if (this.statechange) this.statechange(); }
}
function setup(options={}) {
  const context = options.context || new Context();
  let creations = 0;
  const audio = Audio.create({...options,getContext:() => { creations++; return context; }});
  return {audio,context,creations:() => creations};
}

test('browser UMD creates no context while loading, constructing, or playing before gesture', () => {
  let creations = 0;
  const sandbox = {AudioContext:class extends Context { constructor() { super(); creations++; } }};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../game-audio.js'),'utf8'),sandbox);
  assert.equal(typeof sandbox.CatAudio.create,'function');
  const audio = sandbox.CatAudio.create();
  assert.equal(audio.play('found',{id:'silent-before-gesture'}),false);
  audio.setVolume(0.5); audio.setMuted(false); audio.stopAll();
  assert.equal(creations,0); assert.equal(audio.getState().contextCreated,false);
});

test('unlock lazily creates a single context, repeated gestures and resets reuse it', async () => {
  const {audio,context,creations} = setup();
  assert.equal(creations(),0);
  for (let i=0; i<8; i++) { assert.equal(await audio.unlockFromGesture(),true); audio.resetMatch(); }
  assert.equal(creations(),1); assert.equal(context.resumes,0);
  assert.equal(audio.getState().volume,0.45);
  assert.equal(audio.play('found',{id:'a'}),true);
  assert.equal(context.oscillators.length,Audio.score('found').length);
});

test('pre-unlock IDs are consumed and are never replayed after gesture', async () => {
  const {audio,context} = setup();
  assert.equal(audio.play('found',{id:'old'}),false);
  await audio.unlockFromGesture();
  assert.equal(audio.play('found',{id:'old'}),false);
  assert.equal(context.oscillators.length,0);
  assert.equal(audio.play('found',{id:'fresh'}),true);
});

test('muted events stay silent, consume IDs and cannot queue a later burst', async () => {
  const {audio,context} = setup({muted:true});
  await audio.unlockFromGesture();
  assert.equal(audio.play('win',{id:'muted-win'}),false);
  assert.equal(context.oscillators.length,0);
  assert.equal(audio.setMuted(false),false);
  assert.equal(audio.play('win',{id:'muted-win'}),false);
  audio.play('found',{id:'new'});
  audio.setMuted(true);
  assert.equal(audio.getState().activeVoices,0);
  assert.ok(context.oscillators.every(o => o.disconnected));
  audio.setMuted(false);
  assert.equal(audio.getState().activeVoices,0);
});

test('volume clamps and ramps; zero volume consumes events and cancels scheduled notes', async () => {
  const {audio,context} = setup({volume:9});
  assert.equal(audio.getState().volume,1);
  await audio.unlockFromGesture();
  assert.equal(context.gains[0].gain.value,Audio.constants.MASTER_GAIN / Audio.constants.LIMITER_INPUT_RANGE);
  audio.play('start',{id:'start',delay:0.8});
  assert.equal(audio.setVolume(-3),0);
  assert.equal(audio.getState().activeVoices,0);
  assert.equal(audio.play('impact',{id:'zero'}),false);
  assert.equal(audio.setVolume(0.37),0.37);
  assert.equal(audio.setVolume(NaN),0.37);
  assert.equal(audio.play('impact',{id:'zero'}),false);
  assert.equal(context.gains[0].gain.value,0.37 * Audio.constants.MASTER_GAIN / Audio.constants.LIMITER_INPUT_RANGE);
});

test('same sound and ID only play once; one event can trigger distinct sound kinds', async () => {
  const {audio} = setup(); await audio.unlockFromGesture();
  assert.equal(audio.play('found',{id:'event-7'}),true);
  assert.equal(audio.play('found',{id:'event-7'}),false);
  assert.equal(audio.play('hit',{id:'event-7'}),false);
  assert.equal(audio.play('launch',{id:'event-7'}),true);
  assert.equal(audio.play('impact',{id:'event-7'}),true);
  assert.equal(audio.play('found',{id:'event-8'}),true);
  assert.equal(audio.play('ui'),true); assert.equal(audio.play('ui'),true);
});

test('stopping for pause/reconnect preserves dedupe; only resetMatch clears it', async () => {
  const {audio} = setup(); await audio.unlockFromGesture();
  audio.play('found',{id:'event-1'}); audio.stopAll();
  await audio.unlockFromGesture();
  assert.equal(audio.play('found',{id:'event-1'}),false);
  audio.resetMatch();
  assert.equal(audio.play('found',{id:'event-1'}),true);
});

test('event memory is bounded even when muted or never unlocked', () => {
  const {audio,creations} = setup({muted:true});
  for (let i=0; i<2000; i++) audio.play('found',{id:i});
  assert.equal(audio.getState().rememberedIds,Audio.constants.ID_LIMIT);
  assert.equal(creations(),0);
  assert.equal(audio.play('found',{id:'x'.repeat(257)}),false);
  assert.equal(audio.play('found',{id:{}}),false);
  assert.equal(audio.play('unknown',{id:'unknown'}),false);
});

test('rapid and delayed sounds never exceed twelve oscillator voices', async () => {
  const {audio,context} = setup(); await audio.unlockFromGesture();
  for (let i=0; i<100; i++) {
    audio.play('win',{id:i,delay:0.7});
    assert.ok(audio.getState().activeVoices <= Audio.constants.MAX_VOICES);
  }
  assert.equal(context.maxScheduled,12);
  assert.equal(context.oscillators.filter(o => o.active).length,12);
  assert.ok(context.oscillators.slice(0,-12).every(o => o.disconnected));
});

test('stopAll cancels future starts and disconnects every source, and is idempotent', async () => {
  const {audio,context} = setup(); await audio.unlockFromGesture();
  audio.play('win',{id:'future',delay:0.7});
  assert.ok(context.oscillators.every(o => o.startAt > context.currentTime));
  audio.stopAll(); audio.stopAll();
  assert.equal(audio.getState().activeVoices,0);
  assert.ok(context.oscillators.every(o => o.stops.at(-1) === context.currentTime && o.disconnected && o.onended === null));
  assert.ok(context.gains.slice(1).every(g => g.disconnected));
});

test('normal ended callbacks release completed voices and gain nodes', async () => {
  const {audio,context} = setup(); await audio.unlockFromGesture();
  audio.play('found');
  context.oscillators.forEach(o => o.finish());
  assert.equal(audio.getState().activeVoices,0);
  assert.ok(context.oscillators.every(o => o.disconnected));
  assert.ok(context.gains.slice(1).every(g => g.disconnected));
});

test('suspension cancels pending cues; automatic resume never replays stale events', async () => {
  const {audio,context,creations} = setup(); await audio.unlockFromGesture();
  audio.play('win',{id:'old',delay:0.4});
  context.changeState('suspended');
  assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().unlocked,false);
  assert.equal(audio.play('found',{id:'during-suspend'}),false);
  context.changeState('running');
  assert.equal(audio.play('ui',{id:'auto-resume'}),false);
  await audio.unlockFromGesture();
  assert.equal(audio.play('win',{id:'old'}),false);
  assert.equal(audio.play('found',{id:'during-suspend'}),false);
  assert.equal(audio.play('ui',{id:'auto-resume'}),false);
  assert.equal(audio.play('ui',{id:'fresh'}),true);
  assert.equal(creations(),1);
});

test('play does not call resume when context state changes without a statechange event', async () => {
  const {audio,context} = setup(); await audio.unlockFromGesture();
  audio.play('win',{delay:0.8}); context.state = 'suspended';
  assert.equal(audio.play('ui',{id:'suspended'}),false);
  assert.equal(context.resumes,0); assert.equal(audio.getState().activeVoices,0);
});

test('rejected resume is silent and later successful gesture never replays dropped events', async () => {
  const context = new Context('suspended');
  context.resume = () => Promise.reject(new Error('Autoplay blocked'));
  const {audio,creations} = setup({context});
  assert.equal(await audio.unlockFromGesture(),false);
  assert.equal(audio.play('start',{id:'blocked'}),false);
  context.resume = Context.prototype.resume;
  assert.equal(await audio.unlockFromGesture(),true);
  assert.equal(audio.play('start',{id:'blocked'}),false);
  assert.equal(audio.play('ui',{id:'allowed'}),true);
  assert.equal(creations(),1);
});

test('concurrent unlock attempts share the same pending resume', async () => {
  const context = new Context('suspended'); let resolve, resumes = 0;
  context.resume = () => { resumes++; return new Promise(done => { resolve = () => { context.state='running'; done(); }; }); };
  const {audio,creations} = setup({context});
  const one = audio.unlockFromGesture(), two = audio.unlockFromGesture();
  assert.equal(one,two); assert.equal(resumes,1);
  resolve(); assert.equal(await one,true); assert.equal(creations(),1);
});

test('closed audio context fails quietly without creating replacements', async () => {
  const {audio,context,creations} = setup(); await audio.unlockFromGesture();
  context.changeState('closed');
  assert.equal(await audio.unlockFromGesture(),false);
  assert.equal(audio.play('found'),false); assert.equal(creations(),1);
});

test('hidden document cancels queued voices and consumes events without resuming', async () => {
  let hidden = false;
  const {audio,context} = setup({isHidden:() => hidden}); await audio.unlockFromGesture();
  audio.play('win',{delay:0.6}); hidden = true;
  assert.equal(audio.play('found',{id:'background'}),false);
  assert.equal(audio.getState().activeVoices,0);
  assert.equal(await audio.unlockFromGesture(),false);
  hidden = false;
  assert.equal(audio.play('found',{id:'background'}),false);
  assert.equal(context.resumes,0);
});

test('document visibility listener stops already scheduled audio without another play', async () => {
  let listener;
  const context = new Context();
  const document = {hidden:false,addEventListener(event,callback) { assert.equal(event,'visibilitychange'); listener=callback; }};
  const sandbox = {document}; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../game-audio.js'),'utf8'),sandbox);
  const audio = sandbox.CatAudio.create({getContext:() => context});
  await audio.unlockFromGesture(); audio.play('win',{delay:0.6});
  document.hidden = true; listener();
  assert.equal(audio.getState().activeVoices,0);
  document.hidden = false; listener();
  assert.equal(audio.getState().activeVoices,0);
});

test('all cues have deterministic frozen, gentle envelopes with distinct scores', () => {
  const fingerprints = new Set();
  for (const kind of Audio.kinds) {
    const notes = Audio.score(kind,{combo:3});
    assert.ok(notes.length > 0); assert.ok(Object.isFrozen(notes));
    assert.deepEqual(notes,Audio.score(kind,{combo:3}));
    fingerprints.add(JSON.stringify(notes));
    for (const note of notes) {
      assert.ok(Object.isFrozen(note)); assert.ok(Object.isFrozen(note.frequency));
      assert.ok(['sine','triangle'].includes(note.wave));
      assert.equal(note.envelope[0].value,0); assert.equal(note.envelope.at(-1).value,0);
      assert.ok(note.envelope.every(p => p.value >= 0 && p.value <= 0.13));
      assert.ok(note.frequency.every(p => p.value >= 90 && p.value < 1320));
      assert.ok(note.duration > 0.06 && note.duration < 0.5);
    }
  }
  assert.equal(fingerprints.size,Audio.kinds.length);
  assert.notDeepEqual(Audio.score('combo',{combo:2}),Audio.score('combo',{combo:5}));
  assert.deepEqual(Audio.score('combo',{combo:99}),Audio.score('combo',{combo:16}));
});

test('shared soft limiter is symmetric, finite and strictly below full scale', async () => {
  for (const value of [0,0.1,0.5,1,5,1000]) {
    assert.ok(Number.isFinite(Audio.softLimit(value)));
    assert.ok(Audio.softLimit(value)<1);
    assert.equal(Audio.softLimit(-value),-Audio.softLimit(value));
  }
  const {audio,context} = setup(); await audio.unlockFromGesture();
  assert.equal(context.limiter.curve.length,1025);
  assert.equal(context.limiter.oversample,'2x');
  assert.ok(context.limiter.curve.every(v => Math.abs(v)<1));
  const {MAX_VOICES,MASTER_GAIN,LIMITER_INPUT_RANGE} = Audio.constants;
  const maxNoteGain = Math.max(...Audio.kinds.flatMap(kind => Audio.score(kind).flatMap(note => note.envelope.map(p => p.value))));
  const maximumCurveInput = MAX_VOICES * maxNoteGain * MASTER_GAIN / LIMITER_INPUT_RANGE;
  assert.ok(maximumCurveInput < 1,'even full-volume maximum voice overlap avoids the WaveShaper hard input clamp');
  assert.ok(Audio.softLimit(MAX_VOICES * maxNoteGain * MASTER_GAIN) < 0.9);
  for (const input of [-maximumCurveInput,-0.04,0,0.04,maximumCurveInput]) {
    const index=(input+1)/2*(context.limiter.curve.length-1);
    const lower=Math.floor(index),upper=Math.ceil(index);
    const interpolated=context.limiter.curve[lower]+(context.limiter.curve[upper]-context.limiter.curve[lower])*(index-lower);
    assert.ok(Math.abs(interpolated-Audio.softLimit(input*LIMITER_INPUT_RANGE)) < 0.00003,
      'browser saturation curve agrees with offline output gain');
  }
});

test('delay is bounded and unknown cues do not allocate nodes', async () => {
  const {audio,context} = setup(); await audio.unlockFromGesture();
  assert.equal(audio.play('missing',{id:'x'}),false);
  assert.equal(context.oscillators.length,0);
  audio.play('ui',{delay:100});
  assert.equal(context.oscillators.at(-1).startAt,context.currentTime+1);
  audio.play('ui',{delay:-100});
  assert.equal(context.oscillators.at(-1).startAt,context.currentTime);
});

test('offline preview uses every supported cue and renders deterministic, unclipped PCM', () => {
  const renderer = require('../scripts/render-audio-preview.js');
  assert.deepEqual(new Set(renderer.CUES.map(c => c.kind)),new Set(Audio.kinds));
  const rendered = renderer.render();
  assert.equal(rendered.samples.length,12*44100);
  const peakDb = 20*Math.log10(rendered.peak);
  assert.ok(peakDb > -20 && peakDb < -18,'default-volume preview has a useful clean sound level');
  assert.ok(rendered.rms > 0);
  assert.ok(rendered.samples.every(Number.isFinite));
  assert.ok(rendered.samples.slice(0,Math.floor(0.19*44100)).every(value => value===0));
  assert.ok(rendered.samples.slice(11*44100).every(value => value===0));
  const wav = renderer.wav(rendered.samples);
  assert.equal(wav.toString('ascii',0,4),'RIFF');
  assert.equal(wav.toString('ascii',8,12),'WAVE');
  assert.equal(wav.readUInt32LE(24),44100); assert.equal(wav.readUInt16LE(34),16);
  assert.equal(wav.readUInt32LE(40),12*44100*2);
  assert.equal(wav.length,44+12*44100*2);
  const repeated = renderer.wav(renderer.render().samples);
  assert.deepEqual(wav,repeated);
});

test('offline oscillator exactly integrates linear glides and interpolates envelopes', () => {
  const {phaseAt,envelopeAt} = require('../scripts/render-audio-preview.js');
  const glide = [{time:0,value:100},{time:1,value:200},{time:2,value:100}];
  assert.equal(phaseAt(glide,0.5),62.5);
  assert.equal(phaseAt(glide,1),150);
  assert.equal(phaseAt(glide,2),300);
  assert.equal(envelopeAt([{time:0,value:0},{time:1,value:0.1}],0.5),0.05);
});
