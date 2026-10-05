/* Original, asset-free Cat Battle sound palette. No context or sound until a gesture. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_VOICES = 12, ID_LIMIT = 512, DEFAULT_VOLUME = 0.45, MASTER_GAIN = 1.75, LIMITER_INPUT_RANGE = 4;
  const KINDS = Object.freeze(['found','combo','launch','impact','damage','miss','lock','unlock',
    'countdown','start','boardClear','newBoard','win','lose','ui']);
  const ALIASES = Object.freeze({hit:'found',attack:'launch',tick:'countdown',
    'board-clear':'boardClear','new-board':'newBoard',victory:'win',defeat:'lose'});
  const clamp = (value, low, high) => Math.min(high,Math.max(low,value));
  const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const pitch = semitones => 440 * Math.pow(2,semitones / 12);
  const canonical = kind => Object.prototype.hasOwnProperty.call(ALIASES,kind) ? ALIASES[kind] : kind;
  function freeze(value) {
    Object.keys(value).forEach(key => { if (value[key] && typeof value[key] === 'object') freeze(value[key]); });
    return Object.freeze(value);
  }
  function note(when, duration, frequency, gain, wave, bend) {
    const attack = Math.min(0.014,duration * 0.12);
    const release = Math.min(duration * 0.62,0.16);
    return {when,duration,wave:wave || 'sine',
      frequency: bend || [{time:0,value:frequency},{time:duration,value:frequency}],
      envelope:[{time:0,value:0},{time:attack,value:gain},
        {time:Math.max(attack,duration-release),value:gain * 0.65},{time:duration,value:0}]};
  }
  const glide = (from,to,duration) => [{time:0,value:from},{time:duration,value:to}];
  function melody(tones, spacing, duration, gain) {
    return tones.map((tone,index) => note(index * spacing,duration,pitch(tone),gain));
  }
  /* Frozen note data is shared by Web Audio and the offline WAV renderer. Every
     motif is composed here; no recordings, imported songs, speech, or sample packs. */
  function score(kind, options) {
    const level = clamp(Math.floor(finite(options && options.combo,1)),1,16);
    const lift = Math.min(level-1,7);
    let notes;
    switch (canonical(kind)) {
      case 'found': {
        const base = pitch(-2 + Math.min(lift,4));
        notes = [note(0,0.30,base,0.115,'triangle',[
          {time:0,value:base * 0.88},{time:0.065,value:base * 1.20},
          {time:0.14,value:base * 1.10},{time:0.30,value:base * 0.82}]),
          note(0.15,0.17,base * 1.5,0.037)];
        break;
      }
      case 'combo': notes = melody([0 + lift,4 + lift,7 + lift],0.073,0.17,0.071); break;
      case 'launch': notes = [note(0,0.19,260,0.086,'triangle',glide(260,790,0.19)),
        note(0.025,0.17,170,0.038,'sine',glide(170,360,0.17))]; break;
      case 'impact': notes = [note(0,0.15,220,0.125,'sine',glide(220,95,0.15)),
        note(0.013,0.10,430,0.043,'triangle',glide(430,240,0.10))]; break;
      case 'damage': notes = [note(0,0.22,185,0.10,'sine',glide(185,110,0.22)),
        note(0.045,0.16,330,0.04,'triangle',glide(330,230,0.16))]; break;
      case 'miss': notes = [note(0,0.16,350,0.070,'triangle',glide(350,290,0.16)),
        note(0.11,0.20,240,0.065,'sine',glide(240,215,0.20))]; break;
      case 'lock': notes = [note(0,0.075,260,0.044),note(0.095,0.09,220,0.037)]; break;
      case 'unlock': notes = melody([-5,2],0.08,0.16,0.056); break;
      case 'countdown': notes = [note(0,0.12,440,0.066),note(0.005,0.09,660,0.022)]; break;
      case 'start': notes = melody([-5,2,7],0.075,0.23,0.085); break;
      case 'boardClear': notes = melody([-2,2,5,10],0.095,0.24,0.066); break;
      case 'newBoard': notes = [note(0,0.22,330,0.038,'sine',glide(330,440,0.22)),
        note(0.11,0.21,660,0.035)]; break;
      case 'win': notes = melody([-5,0,4,7,12,7],0.13,0.34,0.073); break;
      case 'lose': notes = melody([0,-3,-5],0.15,0.30,0.061); break;
      case 'ui': notes = [note(0,0.075,520,0.025)]; break;
      default: notes = [];
    }
    return freeze(notes);
  }
  function softLimit(sample) { return 0.9 * Math.tanh(sample / 0.9); }

  function create(options) {
    options = options || {};
    let muted = !!options.muted;
    let volume = clamp(finite(options.volume,DEFAULT_VOLUME),0,1);
    let context = null, master = null, limiter = null, unlocked = false, resumePending = null;
    const voices = new Set(), seen = new Set();
    const hidden = () => {
      try { return typeof options.isHidden === 'function' ? !!options.isHidden() : !!(root.document && root.document.hidden); }
      catch (_) { return true; }
    };
    function remember(kind,id) {
      if (id === undefined || id === null) return true;
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length > 256) return false;
      const key = kind + ':' + typeof id + ':' + String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > ID_LIMIT) seen.delete(seen.values().next().value);
      return true;
    }
    function dispose(voice,stop) {
      if (!voices.delete(voice)) return;
      voice.oscillator.onended = null;
      if (stop) {
        try { voice.gain.gain.cancelScheduledValues(0); voice.gain.gain.setValueAtTime(0,context.currentTime); } catch (_) {}
        // Also cancels oscillators with start times in the future.
        try { voice.oscillator.stop(context.currentTime); } catch (_) {}
      }
      try { voice.oscillator.disconnect(); } catch (_) {}
      try { voice.gain.disconnect(); } catch (_) {}
    }
    function stopAll() { Array.from(voices).forEach(voice => dispose(voice,true)); }
    function updateGain() {
      if (!master || !context) return;
      const now = context.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(muted || hidden() ? 0 : volume * MASTER_GAIN / LIMITER_INPUT_RANGE,now,0.012);
      } catch (_) { master.gain.value = muted || hidden() ? 0 : volume * MASTER_GAIN / LIMITER_INPUT_RANGE; }
    }
    function onStateChange() {
      if (context && context.state !== 'running') { unlocked = false; stopAll(); }
    }
    function initialize() {
      if (context) return context.state !== 'closed';
      try {
        if (typeof options.getContext === 'function') context = options.getContext();
        else {
          const Constructor = root.AudioContext || root.webkitAudioContext;
          if (!Constructor) return false;
          context = new Constructor();
        }
        if (!context) return false;
        master = context.createGain();
        master.gain.value = muted || hidden() ? 0 : volume * MASTER_GAIN / LIMITER_INPUT_RANGE;
        // Compensate the input scaling inside the smooth saturation curve. Even
        // all 12 voices at full volume remain within its [-1,1] input domain:
        // 12 * 0.125 * 1.75 / 4 < 1. There is no hard input clamp on overlap.
        // The curve approaches 0.9, leaving output headroom at every volume.
        if (typeof context.createWaveShaper === 'function') {
          limiter = context.createWaveShaper();
          const curve = new Float32Array(1025);
          for (let i = 0; i < curve.length; i++) curve[i] = softLimit((i * 2 / (curve.length-1) - 1) * LIMITER_INPUT_RANGE);
          limiter.curve = curve; limiter.oversample = '2x';
          master.connect(limiter); limiter.connect(context.destination);
        } else master.connect(context.destination);
        if (typeof context.addEventListener === 'function') context.addEventListener('statechange',onStateChange);
        else context.onstatechange = onStateChange;
        return true;
      } catch (_) { unlocked = false; return false; }
    }
    function unlockFromGesture() {
      // This is the only code path allowed to construct or resume AudioContext.
      if (!initialize() || hidden()) return Promise.resolve(false);
      if (context.state === 'running') { unlocked = true; updateGain(); return Promise.resolve(true); }
      if (context.state === 'closed') return Promise.resolve(false);
      if (resumePending) return resumePending;
      stopAll();
      try {
        resumePending = Promise.resolve(context.resume()).then(() => {
          unlocked = context.state === 'running' && !hidden();
          updateGain(); return unlocked;
        },() => { unlocked = false; stopAll(); return false; }).finally(() => { resumePending = null; });
      } catch (_) { unlocked = false; resumePending = null; return Promise.resolve(false); }
      return resumePending;
    }
    function play(kind, detail) {
      detail = detail || {}; kind = canonical(kind);
      if (!KINDS.includes(kind) || !remember(kind,detail.id)) return false;
      // Consume the ID before any gate: toggling audio/reconnecting never replays
      // historical sounds. Nothing is buffered while autoplay or tab focus blocks it.
      if (muted || volume <= 0 || hidden() || !unlocked || !context || context.state !== 'running') {
        if (hidden() || (context && context.state !== 'running')) { stopAll(); if (context && context.state !== 'running') unlocked = false; }
        return false;
      }
      const notes = score(kind,detail);
      const start = context.currentTime + clamp(finite(detail.delay,0),0,1);
      let played = false;
      for (const part of notes) {
        while (voices.size >= MAX_VOICES) dispose(voices.values().next().value,true);
        let oscillator, gain, voice;
        try {
          oscillator = context.createOscillator(); gain = context.createGain();
          voice = {oscillator,gain}; voices.add(voice);
          oscillator.type = part.wave;
          oscillator.connect(gain); gain.connect(master);
          const at = start + part.when;
          part.frequency.forEach((point,index) => oscillator.frequency[index ? 'linearRampToValueAtTime' : 'setValueAtTime'](point.value,at+point.time));
          part.envelope.forEach((point,index) => gain.gain[index ? 'linearRampToValueAtTime' : 'setValueAtTime'](point.value,at+point.time));
          oscillator.onended = () => dispose(voice,false);
          oscillator.start(at); oscillator.stop(at + part.duration + 0.006);
          played = true;
        } catch (_) {
          if (voice) dispose(voice,true);
          else { try { if (oscillator) oscillator.disconnect(); if (gain) gain.disconnect(); } catch (_) {} }
        }
      }
      return played;
    }
    function setMuted(value) { muted = !!value; if (muted) stopAll(); updateGain(); return muted; }
    function setVolume(value) { volume = clamp(finite(value,volume),0,1); if (!volume) stopAll(); updateGain(); return volume; }
    function resetMatch() { stopAll(); seen.clear(); }
    function getState() {
      return Object.freeze({muted,volume,unlocked,contextCreated:!!context,activeVoices:voices.size,
        rememberedIds:seen.size,maxVoices:MAX_VOICES});
    }
    // Protect delayed notes even if the app's own visibility handler runs later.
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange',() => { if (hidden()) stopAll(); updateGain(); });
    }
    return Object.freeze({unlockFromGesture,play,setMuted,setVolume,stopAll,resetMatch,getState});
  }
  return Object.freeze({create,score,softLimit,kinds:KINDS,
    constants:Object.freeze({MAX_VOICES,ID_LIMIT,DEFAULT_VOLUME,MASTER_GAIN,LIMITER_INPUT_RANGE})});
});
