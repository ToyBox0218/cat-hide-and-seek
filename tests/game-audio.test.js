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
  start(time) { this.startAt = time; this.active = true; this.context.maxScheduled = Math.max(this.context.maxScheduled,[...this.context.oscillators,...this.context.bufferSources].filter(o => o.active).length); }
  stop(time) { this.stops.push(time); if (time <= this.context.currentTime) this.active = false; }
  finish() { this.active = false; if (this.onended) this.onended(); }
}
class BufferSource extends Oscillator {
  constructor(context) { super(context); this.playbackRate = new Param(1); }
}
function sampleBuffer(peak=0.5,duration=0.5,channels=1) {
  const pcm = new Float32Array([0,peak,-peak,0]);
  return {duration,numberOfChannels:channels,getChannelData:() => pcm};
}
class Context {
  constructor(state='running') { this.state = state; this.currentTime = 10; this.destination = {}; this.oscillators = []; this.bufferSources = []; this.decodes = []; this.gains = []; this.resumes = 0; this.maxScheduled = 0; }
  createGain() { const node = new Node(this); node.gain = new Param(1); this.gains.push(node); return node; }
  createOscillator() { const node = new Oscillator(this); this.oscillators.push(node); return node; }
  createBufferSource() { const node = new BufferSource(this); this.bufferSources.push(node); return node; }
  decodeAudioData(bytes) { this.decodes.push(bytes); return Promise.resolve(sampleBuffer()); }
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


function sampleSetup(options={}) {
  const fetches = [];
  const fetcher = async url => {
    fetches.push(url);
    return {ok:true,arrayBuffer:async () => new Uint8Array([1,2,3,4]).buffer};
  };
  return {...setup({samples:['soft.wav','food.wav'],fetcher,...options}),fetches};
}

test('sample URLs do not fetch, decode, or create context until an audible gesture', async () => {
  for (const state of [{},{muted:true},{volume:0},{isHidden:() => true}]) {
    const {audio,context,creations,fetches} = sampleSetup(state);
    assert.equal(await audio.preload(),false);
    assert.equal(await audio.loadSamples(),false);
    assert.equal(audio.play('meow',{id:'before'}),false);
    assert.equal(creations(),0); assert.equal(fetches.length,0); assert.equal(context.decodes.length,0);
    if (state.muted || state.volume === 0 || state.isHidden) {
      assert.equal(await audio.unlockFromGesture(),false);
      assert.equal(creations(),0); assert.equal(fetches.length,0);
    }
  }
});

test('gesture loads each recording once and repeated preload shares its promise', async () => {
  const {audio,context,fetches} = sampleSetup();
  assert.equal(await audio.unlockFromGesture(),true);
  const first=audio.loadSamples(),second=audio.preload();
  assert.equal(first,second); assert.equal(await first,true);
  for (let i=0;i<4;i++) await audio.unlockFromGesture();
  assert.deepEqual(fetches,['soft.wav','food.wav']); assert.equal(context.decodes.length,2);
  assert.equal(audio.getState().loadedSamples,2); assert.equal(audio.getState().samplesStatus,'ready');
  assert.equal(context.bufferSources.length,0); assert.equal(context.oscillators.length,0);
});

test('raw bytes, typed-array views, descriptors, and data URLs use the same lazy loader', async () => {
  const backing = new Uint8Array([9,2,3,9]);
  const {audio,context,fetches} = sampleSetup({samples:[
    new Uint8Array([1]).buffer,{data:backing.subarray(1,3),gain:0.1},'data:audio/wav;base64,AAAA'
  ]});
  await audio.unlockFromGesture(); assert.equal(await audio.loadSamples(),true);
  assert.equal(context.decodes.length,3);
  assert.deepEqual(Array.from(new Uint8Array(context.decodes[1])),[2,3]);
  assert.deepEqual(fetches,['data:audio/wav;base64,AAAA']);
  assert.equal(audio.getState().loadedSamples,3);
});

test('sample source list is capped at three variants and accepts predecoded buffers after gesture', async () => {
  const {audio,context,fetches,creations} = sampleSetup({samples:Array.from({length:5},() => ({buffer:sampleBuffer()}))});
  assert.equal(creations(),0); assert.equal(audio.getState().loadedSamples,0);
  await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.getState().loadedSamples,3); assert.equal(context.decodes.length,0); assert.equal(fetches.length,0);
});

test('callback-only decodeAudioData and failed decodes settle safely', async () => {
  const context = new Context();
  context.decodeAudioData=(bytes,success) => { queueMicrotask(() => success(sampleBuffer())); };
  const {audio} = sampleSetup({context});
  await audio.unlockFromGesture(); assert.equal(await audio.loadSamples(),true);
  const failing = new Context(); failing.decodeAudioData=() => Promise.reject(new Error('invalid wav'));
  const failed = sampleSetup({context:failing}).audio;
  await failed.unlockFromGesture(); assert.equal(await failed.loadSamples(),false);
  assert.equal(failed.getState().samplesStatus,'failed'); assert.equal(failed.getState().failedSamples,2);
  assert.equal(failed.play('meow',{id:'fallback'}),true); assert.equal(failed.getState().lastMeowSource,'synth');
});

test('partial sample failures retain usable recordings without retry storms', async () => {
  let calls=0;
  const {audio,context} = sampleSetup({fetcher:async url => {
    calls++;
    if (url === 'food.wav') throw new Error('offline');
    return {ok:true,arrayBuffer:async () => new Uint8Array([1]).buffer};
  }});
  await audio.unlockFromGesture(); assert.equal(await audio.loadSamples(),true);
  assert.equal(audio.getState().samplesStatus,'partial'); assert.equal(audio.getState().failedSamples,1);
  assert.equal(audio.getState().loadedSamples,1);
  await audio.unlockFromGesture(); await audio.loadSamples(); assert.equal(calls,2);
  assert.equal(audio.play('meow',{id:'works'}),true); assert.equal(context.bufferSources.length,1);
});

test('non-OK fetches and invalid, silent, or missing sample data fall back without throwing', async () => {
  for (const options of [
    {fetcher:async () => ({ok:false,arrayBuffer:async () => new ArrayBuffer(1)})},
    {samples:[{buffer:sampleBuffer(0)}]},
    {samples:[{buffer:sampleBuffer(Infinity)}]},
    {samples:[{buffer:sampleBuffer(0.5,20)}]},
    {samples:[{}]}
  ]) {
    const {audio,context}=sampleSetup(options);
    await audio.unlockFromGesture(); assert.equal(await audio.loadSamples(),false);
    assert.equal(audio.getState().samplesStatus,'failed');
    assert.equal(audio.play('meow',{id:'synth-fallback'}),true);
    assert.equal(audio.getState().lastMeowSource,'synth'); assert.equal(context.bufferSources.length,0);
  }
});

test('late samples never replay earlier captures or replace their already playing fallback', async () => {
  const context=new Context(); let finishDecode;
  context.decodeAudioData=() => new Promise(resolve => { finishDecode=resolve; });
  const {audio}=sampleSetup({context,samples:['soft.wav']});
  assert.equal(audio.play('meow',{id:'before-unlock'}),false);
  await audio.unlockFromGesture();
  // Fetch is async; let it reach the deferred decoder, without awaiting readiness.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(audio.play('meow',{id:'before-ready'}),true);
  assert.equal(audio.getState().lastMeowSource,'synth');
  const oldCount=context.oscillators.length;
  finishDecode(sampleBuffer()); await audio.loadSamples();
  assert.equal(context.bufferSources.length,0); assert.equal(context.oscillators.length,oldCount);
  assert.equal(audio.play('meow',{id:'before-ready'}),false);
  assert.equal(audio.play('found',{id:'before-ready'}),false);
  assert.equal(audio.play('meow',{id:'before-unlock'}),false);
  context.currentTime+=0.2;
  assert.equal(audio.play('meow',{id:'fresh'}),true); assert.equal(context.bufferSources.length,1);
});

test('one capture produces one real meow even with a high combo and alias redelivery', async () => {
  const {audio,context}=sampleSetup(); await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.play('meow',{id:'capture',combo:12}),true);
  assert.equal(context.bufferSources.length,1); assert.equal(context.oscillators.length,0);
  assert.equal(audio.play('found',{id:'capture',combo:12}),false);
  assert.equal(audio.play('hit',{id:'capture',combo:12}),false);
  assert.equal(audio.play('meow',{id:'capture',combo:12}),false);
  assert.equal(audio.play('combo',{id:'capture',combo:12,delay:0.12}),true);
  assert.equal(context.bufferSources.length,1); assert.equal(context.oscillators.length,3);
});

test('found keeps original synth before sample readiness and uses a recording once ready', async () => {
  const noSamples=setup(); await noSamples.audio.unlockFromGesture();
  assert.equal(noSamples.audio.play('found'),true);
  assert.equal(noSamples.context.oscillators.length,Audio.score('found').length);
  const {audio,context}=sampleSetup(); await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.play('found',{id:'legacy-capture'}),true);
  assert.equal(context.bufferSources.length,1); assert.equal(context.oscillators.length,0);
  assert.equal(audio.getState().lastMeowSource,'sample');
});

test('shuffle bags use each real recording once, without repeats across bag boundaries', async () => {
  const buffers=[sampleBuffer(),sampleBuffer(),sampleBuffer()];
  let randomCalls=0;
  const {audio,context}=sampleSetup({samples:buffers.map(buffer => ({buffer})),random:() => { randomCalls++; return 0; }});
  await audio.unlockFromGesture(); await audio.loadSamples();
  const order=[];
  for (let i=0;i<18;i++) {
    context.currentTime+=0.2; audio.play('meow',{id:'event-'+i,combo:1+i});
    const source=context.bufferSources.at(-1),rate=source.playbackRate.calls[0][1];
    assert.ok(rate>=0.96 && rate<=1.04);
    order.push(buffers.indexOf(source.buffer));
  }
  for (let i=0;i<order.length;i+=3) assert.deepEqual(new Set(order.slice(i,i+3)),new Set([0,1,2]));
  for (let i=1;i<order.length;i++) assert.notEqual(order[i],order[i-1]);
  assert.equal(randomCalls,12); assert.equal(audio.getState().loadedSamples,3);
});

test('injected randomness controls recording order while event ID keeps pitch independent of combo', async () => {
  async function renderOrder(random) {
    const buffers=[sampleBuffer(),sampleBuffer(),sampleBuffer()];
    const {audio,context}=sampleSetup({samples:buffers.map(buffer => ({buffer})),random});
    await audio.unlockFromGesture(); await audio.loadSamples();
    const order=[];
    for (let i=0;i<6;i++) {
      audio.resetMatch(); audio.play('meow',{id:'same-pitch',combo:i+1});
      const source=context.bufferSources.at(-1);
      order.push({index:buffers.indexOf(source.buffer),rate:source.playbackRate.calls[0][1]});
    }
    assert.equal(new Set(order.map(item => item.rate)).size,1);
    return order;
  }
  assert.deepEqual(await renderOrder(() => 0),await renderOrder(() => 0));
  assert.notDeepEqual(await renderOrder(() => 0),await renderOrder(() => 0.999));
});

test('rapid captures are bounded to two meows with 180 ms spacing and consume dropped IDs', async () => {
  const {audio,context}=sampleSetup(); await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.play('meow',{id:'one'}),true);
  context.currentTime+=0.17;
  assert.equal(audio.play('meow',{id:'too-soon'}),false); assert.equal(context.bufferSources.length,1);
  context.currentTime+=0.01;
  assert.equal(audio.play('meow',{id:'two'}),true); assert.equal(audio.getState().activeMeows,2);
  context.currentTime+=0.18;
  assert.equal(audio.play('meow',{id:'three'}),true); assert.equal(audio.getState().activeMeows,2);
  assert.equal(context.bufferSources[0].disconnected,false);
  assert.equal(context.bufferSources[0].stops.at(-1),context.currentTime+Audio.constants.MEOW_REPLACE_FADE);
  assert.equal(context.bufferSources[2].startAt,context.bufferSources[0].stops.at(-1));
  context.currentTime+=0.2;
  assert.equal(audio.play('meow',{id:'too-soon'}),false);
  assert.equal(context.bufferSources.length,3);
});

test('recorded meows and synth fallback sources share the twelve-voice limit', async () => {
  for (const sampled of [true,false]) {
    const {audio,context}=sampleSetup({samples:sampled ? ['soft.wav'] : []});
    await audio.unlockFromGesture(); await audio.loadSamples();
    for (let i=0;i<100;i++) {
      context.currentTime+=0.18;
      audio.play('meow',{id:i}); audio.play('win',{id:i,delay:0.2});
      assert.ok(audio.getState().activeVoices<=12); assert.ok(audio.getState().activeMeows<=2);
    }
    assert.ok(context.maxScheduled<=12);
    assert.ok([...context.oscillators,...context.bufferSources].filter(source => source.active).length<=12);
  }
});

test('a meow ducks existing and subsequent combo/found/launch beds while impacts bypass the music bus', async () => {
  const {audio,context}=sampleSetup({samples:[]}); await audio.unlockFromGesture();
  audio.play('found',{id:'earlier-music'});
  const oldGain=context.oscillators[0].connections[0];
  audio.play('meow',{id:'cat'});
  audio.play('combo',{id:'cat',combo:4,delay:0.12});
  const comboGain=context.oscillators.at(-1).connections[0];
  const bus=comboGain.connections.at(-1);
  assert.equal(oldGain.connections.at(-1),bus);
  assert.equal(bus.connections[0],context.gains[0]);
  assert.ok(bus.gain.calls.some(call => call[0]==='ramp' && call[1]===Audio.constants.MUSIC_BED_GAIN*Audio.constants.MUSIC_DUCK_GAIN));
  assert.ok(bus.gain.calls.some(call => call[0]==='ramp' && call[1]===Audio.constants.MUSIC_BED_GAIN));
  audio.play('launch',{id:'launch'});
  assert.equal(context.oscillators.at(-1).connections[0].connections[0],bus);
  audio.play('impact',{id:'impact'});
  assert.equal(context.oscillators.at(-1).connections[0].connections[0],context.gains[0]);
});

test('sample envelope is softly faded, gain-capped, and attenuates over-range source PCM', async () => {
  const {audio,context}=sampleSetup({samples:[{buffer:sampleBuffer(2),gain:10}]});
  await audio.unlockFromGesture(); await audio.loadSamples(); audio.play('meow',{id:'level'});
  const gain=context.bufferSources[0].connections[0].gain;
  assert.equal(gain.calls[0][1],0); assert.equal(gain.calls.at(-1)[1],0);
  const peak=Math.max(...gain.calls.map(call => call[1]));
  assert.equal(peak,Audio.constants.SAMPLE_GAIN_LIMIT/2);
  const {MAX_MEOWS,MAX_VOICES,SAMPLE_GAIN_LIMIT,MASTER_GAIN,LIMITER_INPUT_RANGE}=Audio.constants;
  assert.ok((MAX_MEOWS*SAMPLE_GAIN_LIMIT+(MAX_VOICES-MAX_MEOWS)*0.125)*MASTER_GAIN/LIMITER_INPUT_RANGE<1);
  const defaultPeak=Audio.softLimit(0.5*Audio.constants.SAMPLE_GAIN*Audio.constants.DEFAULT_VOLUME*MASTER_GAIN);
  assert.ok(20*Math.log10(defaultPeak)>-20 && 20*Math.log10(defaultPeak)<-16);
});

test('stop, pause, mute, zero volume, suspension, and hidden state cancel delayed samples and duck automation', async () => {
  for (const action of ['stop','reset','mute','zero','suspend','hidden']) {
    let hidden=false;
    const {audio,context}=sampleSetup({isHidden:() => hidden});
    await audio.unlockFromGesture(); await audio.loadSamples();
    audio.play('meow',{id:'future',delay:0.8});
    audio.play('combo',{id:'future',delay:0.92});
    const source=context.bufferSources[0],bus=context.oscillators[0].connections[0].connections[0];
    assert.ok(source.startAt>context.currentTime);
    if (action==='stop') audio.stopAll();
    if (action==='reset') audio.resetMatch();
    if (action==='mute') audio.setMuted(true);
    if (action==='zero') audio.setVolume(0);
    if (action==='suspend') context.changeState('suspended');
    if (action==='hidden') { hidden=true; audio.play('ui'); }
    assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().activeMeows,0);
    assert.ok(source.disconnected); assert.equal(source.onended,null); assert.equal(source.stops.at(-1),context.currentTime);
    assert.deepEqual(bus.gain.calls.at(-2),['cancel',0]);
    assert.deepEqual(bus.gain.calls.at(-1),['set',Audio.constants.MUSIC_BED_GAIN,context.currentTime]);
  }
});

test('sample decoding finishing after stopAll cannot create playback or a delayed burst', async () => {
  const context=new Context(); let resolveDecode;
  context.decodeAudioData=() => new Promise(resolve => { resolveDecode=resolve; });
  const {audio}=sampleSetup({context,samples:['soft.wav']});
  await audio.unlockFromGesture(); await Promise.resolve(); await Promise.resolve();
  audio.play('meow',{id:'old'}); audio.stopAll();
  resolveDecode(sampleBuffer()); await audio.loadSamples();
  assert.equal(audio.getState().activeVoices,0); assert.equal(context.bufferSources.length,0);
  assert.equal(audio.play('meow',{id:'old'}),false);
});

test('sample completion releases its voice and meow slot; buffer-source failure uses honest synth fallback', async () => {
  const {audio,context}=sampleSetup(); await audio.unlockFromGesture(); await audio.loadSamples();
  audio.play('meow',{id:'done'}); context.bufferSources[0].finish();
  assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().activeMeows,0);
  assert.equal(context.bufferSources[0].disconnected,true);
  context.currentTime+=0.2; context.createBufferSource=() => { throw new Error('unavailable'); };
  assert.equal(audio.play('meow',{id:'fallback'}),true);
  assert.equal(audio.getState().lastMeowSource,'synth'); assert.equal(audio.getState().activeMeows,1);
});


test('browser global data-URL sample configuration remains inert until the first gesture', async () => {
  const context=new Context(),fetches=[];
  const sandbox={CAT_MEOW_SAMPLES:['data:audio/wav;base64,AAAA'],fetch:async url => {
    fetches.push(url); return {ok:true,arrayBuffer:async () => new Uint8Array([1]).buffer};
  }};
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(require.resolve('../game-audio.js'),'utf8'),sandbox);
  const audio=sandbox.CatAudio.create({getContext:() => context});
  assert.equal(audio.getState().samplesStatus,'idle'); assert.equal(fetches.length,0);
  await audio.unlockFromGesture(); await audio.loadSamples();
  assert.deepEqual(fetches,['data:audio/wav;base64,AAAA']);
  assert.equal(audio.play('meow',{id:'embedded'}),true); assert.equal(context.bufferSources.length,1);
});

test('visibility listener cancels a scheduled recording without a subsequent play call', async () => {
  let listener;
  const context=new Context();
  const document={hidden:false,addEventListener(event,callback) { listener=callback; }};
  const sandbox={document}; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../game-audio.js'),'utf8'),sandbox);
  const audio=sandbox.CatAudio.create({getContext:() => context,samples:[{buffer:sampleBuffer()}]});
  await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.play('meow',{id:'delayed',delay:0.8}),true);
  document.hidden=true; listener();
  assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().activeMeows,0);
  assert.equal(context.bufferSources[0].stops.at(-1),context.currentTime);
  document.hidden=false; listener();
  assert.equal(context.bufferSources.length,1); assert.equal(audio.play('meow',{id:'delayed'}),false);
});


test('duplicate, muted, and rate-limited events consume no recording from the shuffle bag', async () => {
  const buffers=[sampleBuffer(),sampleBuffer(),sampleBuffer()];
  const {audio,context}=sampleSetup({samples:buffers.map(buffer => ({buffer})),random:() => 0.999});
  await audio.unlockFromGesture(); await audio.loadSamples();
  assert.equal(audio.play('meow',{id:'one'}),true);
  assert.equal(audio.play('meow',{id:'one'}),false);
  assert.equal(audio.play('found',{id:'one'}),false);
  assert.equal(audio.play('meow',{id:'too-soon'}),false);
  audio.setMuted(true); assert.equal(audio.play('meow',{id:'muted'}),false); audio.setMuted(false);
  context.currentTime+=0.2;
  assert.equal(audio.play('meow',{id:'two'}),true);
  context.currentTime+=0.2;
  assert.equal(audio.play('meow',{id:'three'}),true);
  assert.deepEqual(context.bufferSources.map(source => buffers.indexOf(source.buffer)),[0,1,2]);
  assert.equal(audio.play('meow',{id:'too-soon'}),false);
  assert.equal(audio.play('meow',{id:'muted'}),false);
});

test('fallback playback never consumes actual recording variants or inflates loaded count', async () => {
  const context=new Context(),buffers=[sampleBuffer(),sampleBuffer(),sampleBuffer()];
  let resolveDecode;
  context.decodeAudioData=() => new Promise(resolve => { resolveDecode=resolve; });
  const {audio}=sampleSetup({context,samples:['soft.wav'],random:() => { throw new Error('must not shuffle a fallback'); }});
  await audio.unlockFromGesture(); await Promise.resolve(); await Promise.resolve();
  audio.play('meow',{id:'fallback'});
  assert.equal(audio.getState().loadedSamples,0); assert.equal(audio.getState().lastMeowSource,'synth');
  resolveDecode(buffers[0]); await audio.loadSamples(); context.currentTime+=0.2;
  assert.equal(audio.getState().loadedSamples,1);
  audio.play('meow',{id:'recording'}); assert.equal(context.bufferSources.at(-1).buffer,buffers[0]);
  assert.equal(audio.getState().lastMeowSource,'sample');
});

function assertAtMostTwoAudibleMeows(sources) {
  const events=sources.flatMap(source => [{time:source.startAt,delta:1},{time:source.stops.at(-1),delta:-1}]);
  events.sort((a,b) => a.time-b.time || a.delta-b.delta);
  let active=0;
  for (const event of events) { active+=event.delta; assert.ok(active<=2,'a third meow never overlaps the retiring tail'); }
}

test('oldest sampled meow fades 20 ms before replacement starts, never overlapping a third voice', async () => {
  const {audio,context}=sampleSetup({samples:[{buffer:sampleBuffer(0.5,2)}]});
  await audio.unlockFromGesture(); await audio.loadSamples();
  for (let i=0;i<8;i++) {
    context.currentTime+=0.18; audio.play('meow',{id:i});
    assert.ok(audio.getState().activeMeows<=2);
  }
  for (let i=0;i<6;i++) {
    const outgoing=context.bufferSources[i],incoming=context.bufferSources[i+2];
    const calls=outgoing.connections[0].gain.calls;
    assert.equal(calls.at(-1)[0],'ramp'); assert.equal(calls.at(-1)[1],0);
    assert.equal(calls.at(-1)[2],outgoing.stops.at(-1));
    assert.ok(Math.abs(outgoing.stops.at(-1)-calls.at(-2)[2]-0.02)<1e-8);
    assert.equal(incoming.startAt,outgoing.stops.at(-1));
    assert.equal(outgoing.disconnected,false);
  }
  assertAtMostTwoAudibleMeows(context.bufferSources);
});

test('retiring tails are kept in the twelve-source budget and normal completion releases them', async () => {
  const {audio,context}=sampleSetup({samples:[{buffer:sampleBuffer(0.5,2)}]});
  await audio.unlockFromGesture(); await audio.loadSamples();
  for (let i=0;i<3;i++) { context.currentTime+=0.18; audio.play('meow',{id:i}); }
  assert.equal(audio.getState().activeMeows,2); assert.equal(audio.getState().retiringMeows,1);
  assert.equal(audio.getState().activeVoices,3);
  context.bufferSources[0].finish();
  assert.equal(audio.getState().retiringMeows,0); assert.equal(audio.getState().activeVoices,2);
  assert.equal(context.bufferSources[0].disconnected,true);
});

test('mute, new match, visibility, and stop cancel both outgoing fades and future replacement starts', async () => {
  for (const action of ['mute','reset','hidden','stop']) {
    let hidden=false;
    const {audio,context}=sampleSetup({samples:[{buffer:sampleBuffer(0.5,2)}],isHidden:() => hidden});
    await audio.unlockFromGesture(); await audio.loadSamples();
    for (let i=0;i<3;i++) { context.currentTime+=0.18; audio.play('meow',{id:i}); }
    assert.equal(audio.getState().retiringMeows,1);
    assert.ok(context.bufferSources[2].startAt>context.currentTime);
    if (action==='mute') audio.setMuted(true);
    if (action==='reset') audio.resetMatch();
    if (action==='hidden') { hidden=true; audio.play('ui'); }
    if (action==='stop') audio.stopAll();
    assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().activeMeows,0);
    assert.equal(audio.getState().retiringMeows,0);
    assert.ok(context.bufferSources.every(source => source.disconnected && source.stops.at(-1)===context.currentTime));
  }
});

test('synthetic fallback meow groups also fade before replacement and remain cancellable', async () => {
  const {audio,context}=setup(); await audio.unlockFromGesture();
  for (let i=0;i<3;i++) { context.currentTime+=0.18; audio.play('meow',{id:i}); }
  assert.equal(audio.getState().activeMeows,2); assert.equal(audio.getState().retiringMeows,1);
  const stopAt=context.oscillators[0].stops.at(-1);
  assert.equal(context.oscillators[6].startAt,stopAt);
  for (const source of context.oscillators.slice(0,3)) assert.deepEqual(source.connections[0].gain.calls.at(-1),['ramp',0,stopAt]);
  audio.resetMatch(); assert.equal(audio.getState().activeVoices,0); assert.equal(audio.getState().retiringMeows,0);
});

test('a freshly shuffled first clip matching the previous last clip is moved without losing bag coverage', async () => {
  const buffers=[sampleBuffer(),sampleBuffer(),sampleBuffer()],values=[0.999,0.999,0,0.999];
  const {audio,context}=sampleSetup({samples:buffers.map(buffer => ({buffer})),random:() => values.shift()});
  await audio.unlockFromGesture(); await audio.loadSamples();
  const order=[];
  for (let i=0;i<6;i++) {
    context.currentTime+=0.2; audio.play('meow',{id:i});
    order.push(buffers.indexOf(context.bufferSources.at(-1).buffer));
  }
  assert.deepEqual(order,[0,1,2,1,2,0]);
});

test('fade replacement uses native cancel-and-hold when available and honors future starts', async () => {
  const {audio,context}=sampleSetup({samples:[{buffer:sampleBuffer(0.5,2)}]});
  await audio.unlockFromGesture(); await audio.loadSamples();
  audio.play('meow',{id:'one',delay:0.8});
  const gain=context.bufferSources[0].connections[0].gain;
  gain.cancelAndHoldAtTime=time => gain.calls.push(['hold',time]);
  context.currentTime+=0.18; audio.play('meow',{id:'two',delay:0.8});
  context.currentTime+=0.18; audio.play('meow',{id:'three',delay:0.8});
  assert.deepEqual(gain.calls.at(-2),['hold',context.currentTime+0.8]);
  assert.deepEqual(gain.calls.at(-1),['ramp',0,context.currentTime+0.8+0.02]);
  assert.equal(context.bufferSources[2].startAt,context.bufferSources[0].stops.at(-1));
  assertAtMostTwoAudibleMeows(context.bufferSources);
  audio.stopAll(); assert.equal(audio.getState().retiringMeows,0);
});
