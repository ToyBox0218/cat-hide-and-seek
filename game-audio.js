/* Cat Battle audio: original musical cues plus optional, separately licensed meow
   recordings supplied by the app. No context, sample fetch, or sound before a gesture. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_VOICES = 12, ID_LIMIT = 512, DEFAULT_VOLUME = 0.45, MASTER_GAIN = 1.75, LIMITER_INPUT_RANGE = 4;
  const MAX_MEOWS = 2, MEOW_SPACING = 0.18, MEOW_REPLACE_FADE = 0.02, SAMPLE_GAIN = 0.30, SAMPLE_GAIN_LIMIT = 0.36;
  const MUSIC_BED_GAIN = 0.45, MUSIC_DUCK_GAIN = 0.24;
  const KINDS = Object.freeze(['found','meow','combo','launch','impact','damage','miss','lock','unlock',
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
  /* Frozen synthesis data is shared with the offline renderer. The meow score is
     explicitly a fallback, never a representation of the optional real recording. */
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
      case 'meow':
        // A vowel-like rising/falling fallback while recordings are unavailable.
        notes = [note(0,0.46,240,0.086,'triangle',[
          {time:0,value:240},{time:0.07,value:370},{time:0.16,value:420},
          {time:0.29,value:290},{time:0.46,value:175}]),
          note(0.035,0.39,610,0.030,'sine',[
            {time:0,value:610},{time:0.09,value:870},{time:0.23,value:610},{time:0.39,value:350}]),
          note(0.06,0.36,180,0.021,'sine',[
            {time:0,value:180},{time:0.1,value:215},{time:0.36,value:130}])];
        break;
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
    let context = null, master = null, limiter = null, musicBus = null, unlocked = false, resumePending = null;
    let gestureAuthorized = false, samplesPromise = null, samples = [], failedSamples = 0;
    let lastMeowAt = -Infinity, duckUntil = -Infinity, sequence = 0, lastMeowSource = null;
    let sampleBag = [], lastSampleIndex = -1;
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const configured = Array.isArray(options.samples) ? options.samples : root.CAT_MEOW_SAMPLES;
    const sampleSources = Array.isArray(configured) ? configured.slice(0,3) : [];
    let samplesStatus = sampleSources.length ? 'idle' : 'empty';
    const voices = new Set(), meows = new Set(), retiringMeows = new Set(), seen = new Set();
    const hidden = () => {
      try { return typeof options.isHidden === 'function' ? !!options.isHidden() : !!(root.document && root.document.hidden); }
      catch (_) { return true; }
    };
    function remember(kind,id) {
      if (id === undefined || id === null) return true;
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length > 256) return false;
      // found/hit and meow are alternate names for the same capture, even if the
      // recording finishes loading between two deliveries of that event.
      const key = (kind === 'found' || kind === 'meow' ? 'capture' : kind) + ':' + typeof id + ':' + String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > ID_LIMIT) seen.delete(seen.values().next().value);
      return true;
    }
    function dispose(voice,stop) {
      if (!voices.delete(voice)) return;
      voice.source.onended = null;
      if (stop) {
        try { voice.gain.gain.cancelScheduledValues(0); voice.gain.gain.setValueAtTime(0,context.currentTime); } catch (_) {}
        // Covers both buffer sources and oscillators, including future starts.
        try { voice.source.stop(context.currentTime); } catch (_) {}
      }
      try { voice.source.disconnect(); } catch (_) {}
      try { voice.gain.disconnect(); } catch (_) {}
      if (voice.meow) {
        voice.meow.voices.delete(voice);
        if (!voice.meow.voices.size) { meows.delete(voice.meow); retiringMeows.delete(voice.meow); }
      }
    }
    function envelopeAt(points,time) {
      if (time <= points[0].time) return points[0].value;
      for (let i=1; i<points.length; i++) {
        if (time <= points[i].time) {
          const a=points[i-1],b=points[i];
          return a.value + (b.value-a.value) * (time-a.time) / (b.time-a.time);
        }
      }
      return points[points.length-1].value;
    }
    function retireMeow(meow,at) {
      meows.delete(meow); retiringMeows.add(meow);
      const stopAt = Math.max(at,Math.min(at + MEOW_REPLACE_FADE,meow.end));
      for (const voice of meow.voices) {
        try {
          // Preserve the outgoing waveform's current envelope, then fade it. The
          // replacement starts after this stop, so a retiring tail never makes a
          // third simultaneous meow. Retiring sources remain in the voice budget.
          if (typeof voice.gain.gain.cancelAndHoldAtTime === 'function') voice.gain.gain.cancelAndHoldAtTime(at);
          else {
            voice.gain.gain.cancelScheduledValues(at);
            voice.gain.gain.linearRampToValueAtTime(envelopeAt(voice.envelope,at),at);
          }
          voice.gain.gain.linearRampToValueAtTime(0,stopAt);
          voice.source.stop(stopAt);
        } catch (_) { dispose(voice,true); }
      }
      return stopAt;
    }
    function stopAll() {
      Array.from(voices).forEach(voice => dispose(voice,true));
      meows.clear(); retiringMeows.clear(); lastMeowAt = -Infinity; duckUntil = -Infinity;
      if (musicBus && context) {
        try { musicBus.gain.cancelScheduledValues(0); musicBus.gain.setValueAtTime(MUSIC_BED_GAIN,context.currentTime); } catch (_) {}
      }
    }
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
        // At most two recorded meows at 0.36 peak plus ten synth voices at
        // 0.125 keep the scaled input below one, even at full master volume.
        // The smooth output curve approaches 0.9, preserving output headroom.
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
    function bytesOf(value) {
      if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return value.slice(0);
      if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset,value.byteOffset + value.byteLength);
      return null;
    }
    function decode(bytes) {
      return new Promise((resolve,reject) => {
        try {
          // Support callback-only WebKit and modern promise-based implementations.
          const pending = context.decodeAudioData(bytes,resolve,reject);
          if (pending && typeof pending.then === 'function') pending.then(resolve,reject);
        } catch (error) { reject(error); }
      });
    }
    function prepareSample(buffer,gain) {
      if (!buffer || !(buffer.duration > 0) || !Number.isFinite(buffer.duration) ||
          typeof buffer.getChannelData !== 'function' || !(buffer.numberOfChannels > 0)) throw new Error('Invalid meow buffer');
      // Reject unexpectedly long files and non-finite PCM rather than letting an
      // accidental music track or malformed recording run through the meow bus.
      if (buffer.duration > 8 || buffer.numberOfChannels > 8) throw new Error('Meow recording is too long');
      let peak = 0;
      for (let channel=0; channel<buffer.numberOfChannels; channel++) {
        const pcm = buffer.getChannelData(channel);
        for (let i=0; i<pcm.length; i++) {
          if (!Number.isFinite(pcm[i])) throw new Error('Invalid meow samples');
          peak = Math.max(peak,Math.abs(pcm[i]));
        }
      }
      if (!peak) throw new Error('Silent meow recording');
      // Never boost a quiet recording; attenuate over-range material so the gain
      // ceiling is also a true PCM peak ceiling, independent of source mastering.
      return {buffer,gain:clamp(finite(gain,SAMPLE_GAIN),0,SAMPLE_GAIN_LIMIT) / Math.max(1,peak)};
    }
    function loadSamples() {
      // Calling preload by itself is not a user gesture and never creates a context.
      if (!gestureAuthorized || !context || !unlocked || muted || volume <= 0 || hidden()) return Promise.resolve(false);
      if (samplesPromise) return samplesPromise;
      if (!sampleSources.length) return Promise.resolve(false);
      samplesStatus = 'loading';
      samplesPromise = Promise.all(sampleSources.map(async source => {
        try {
          const descriptor = source && typeof source === 'object' && !ArrayBuffer.isView(source) &&
            Object.prototype.toString.call(source) !== '[object ArrayBuffer]' ? source : {data:source};
          if (descriptor.buffer && typeof descriptor.buffer.getChannelData === 'function') return prepareSample(descriptor.buffer,descriptor.gain);
          let bytes = bytesOf(descriptor.data);
          if (!bytes) {
            const url = typeof source === 'string' ? source : (descriptor.url || descriptor.data);
            const fetcher = options.fetcher || (typeof root.fetch === 'function' && root.fetch.bind(root));
            if (typeof url !== 'string' || !fetcher) throw new Error('No meow sample source');
            const response = await fetcher(url);
            if (!response || response.ok === false || typeof response.arrayBuffer !== 'function') throw new Error('Meow sample fetch failed');
            bytes = await response.arrayBuffer();
          }
          return prepareSample(await decode(bytes),descriptor.gain);
        } catch (_) { failedSamples++; return null; }
      })).then(loaded => {
        samples = loaded.filter(Boolean);
        samplesStatus = samples.length ? (failedSamples ? 'partial' : 'ready') : 'failed';
        // Loading only changes availability. It never replays a dropped hit.
        return samples.length > 0;
      });
      return samplesPromise;
    }
    function finishUnlock() {
      unlocked = context.state === 'running' && !hidden();
      updateGain();
      if (unlocked) { gestureAuthorized = true; void loadSamples(); }
      return unlocked;
    }
    function unlockFromGesture() {
      // This is the only path allowed to construct or resume AudioContext.
      if (muted || volume <= 0 || hidden() || !initialize()) return Promise.resolve(false);
      if (context.state === 'running') return Promise.resolve(finishUnlock());
      if (context.state === 'closed') return Promise.resolve(false);
      if (resumePending) return resumePending;
      stopAll();
      try {
        resumePending = Promise.resolve(context.resume()).then(finishUnlock,
          () => { unlocked = false; stopAll(); return false; }).finally(() => { resumePending = null; });
      } catch (_) { unlocked = false; resumePending = null; return Promise.resolve(false); }
      return resumePending;
    }
    function makeRoom() {
      while (voices.size >= MAX_VOICES) {
        // Musical flourishes yield to the cat voice rather than cutting it off.
        const candidate = Array.from(voices).find(voice => !voice.meow) || voices.values().next().value;
        dispose(candidate,true);
      }
    }
    function ensureMusicBus() {
      if (musicBus) return musicBus;
      musicBus = context.createGain(); musicBus.gain.value = MUSIC_BED_GAIN; musicBus.connect(master);
      for (const voice of voices) {
        if (voice.musical) { voice.gain.disconnect(); voice.gain.connect(musicBus); }
      }
      return musicBus;
    }
    function duckMusic(start,end) {
      const bus = ensureMusicBus(), now = context.currentTime;
      const ducked = MUSIC_BED_GAIN * MUSIC_DUCK_GAIN;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(duckUntil > now ? ducked : MUSIC_BED_GAIN,now);
      bus.gain.linearRampToValueAtTime(ducked,Math.max(start,now) + 0.012);
      duckUntil = Math.max(duckUntil,end + 0.05);
      bus.gain.setValueAtTime(ducked,duckUntil);
      bus.gain.linearRampToValueAtTime(MUSIC_BED_GAIN,duckUntil + 0.09);
    }
    function playNotes(kind,detail,start,meow) {
      let played = false;
      for (const part of score(kind,detail)) {
        makeRoom();
        let source, gain, voice;
        try {
          source = context.createOscillator(); gain = context.createGain();
          voice = {source,gain,meow,musical:kind === 'combo' || kind === 'found' || kind === 'launch'}; voices.add(voice);
          if (meow) { meows.add(meow); meow.voices.add(voice); }
          source.type = part.wave;
          source.connect(gain); gain.connect(voice.musical && musicBus ? musicBus : master);
          const at = start + part.when;
          voice.envelope = part.envelope.map(point => ({time:at + point.time,value:point.value}));
          if (meow) meow.end = Math.max(meow.end,at + part.duration + 0.006);
          part.frequency.forEach((point,index) => source.frequency[index ? 'linearRampToValueAtTime' : 'setValueAtTime'](point.value,at+point.time));
          part.envelope.forEach((point,index) => gain.gain[index ? 'linearRampToValueAtTime' : 'setValueAtTime'](point.value,at+point.time));
          source.onended = () => dispose(voice,false);
          source.start(at); source.stop(at + part.duration + 0.006);
          played = true;
        } catch (_) {
          if (voice) dispose(voice,true);
          else { try { if (source) source.disconnect(); if (gain) gain.disconnect(); } catch (_) {} }
        }
      }
      return played;
    }
    function variation(id) {
      const key = id === undefined || id === null ? 'sequence:' + sequence++ : typeof id + ':' + String(id);
      let hash = 2166136261;
      for (let i=0; i<key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i),16777619) >>> 0;
      return {rate:0.96 + (hash % 9) * 0.01};
    }
    function nextSampleIndex() {
      if (!sampleBag.length) {
        sampleBag = samples.map((_,index) => index);
        // Randomized recordings, without leaving a clip unused or immediately
        // repeating it when a fresh shuffle bag begins.
        for (let i=sampleBag.length-1; i>0; i--) {
          let value;
          try { value = finite(random(),0.5); } catch (_) { value = 0.5; }
          const j = Math.floor(clamp(value,0,1 - Number.EPSILON) * (i + 1));
          [sampleBag[i],sampleBag[j]] = [sampleBag[j],sampleBag[i]];
        }
        if (sampleBag.length > 1 && sampleBag[0] === lastSampleIndex) {
          [sampleBag[0],sampleBag[1]] = [sampleBag[1],sampleBag[0]];
        }
      }
      return sampleBag[0];
    }
    function playMeow(detail,start) {
      if (start - lastMeowAt < MEOW_SPACING - 1e-7) return false;
      const requestedStart = start;
      while (meows.size >= MAX_MEOWS) start = Math.max(start,retireMeow(meows.values().next().value,start));
      const meow = {voices:new Set(),end:start};
      const choice = variation(detail.id);
      const sampleIndex = samples.length ? nextSampleIndex() : undefined, sample = samples[sampleIndex];
      if (sample && typeof context.createBufferSource === 'function') {
        makeRoom();
        let source, gain, voice;
        try {
          source = context.createBufferSource(); gain = context.createGain();
          voice = {source,gain,meow,musical:false}; voices.add(voice); meows.add(meow); meow.voices.add(voice);
          source.buffer = sample.buffer;
          source.playbackRate.setValueAtTime(choice.rate,start);
          source.connect(gain); gain.connect(master);
          const duration = sample.buffer.duration / choice.rate;
          // Fade edges gently without changing the recording's natural phrasing.
          const attack = Math.min(0.012,duration * 0.15), release = Math.min(0.045,duration * 0.25);
          meow.end = start + duration + 0.006;
          voice.envelope = [{time:start,value:0},{time:start + attack,value:sample.gain},
            {time:start + duration - release,value:sample.gain},{time:start + duration,value:0}];
          gain.gain.setValueAtTime(0,start);
          gain.gain.linearRampToValueAtTime(sample.gain,start + attack);
          gain.gain.setValueAtTime(sample.gain,start + duration - release);
          gain.gain.linearRampToValueAtTime(0,start + duration);
          source.onended = () => dispose(voice,false);
          source.start(start); source.stop(start + duration + 0.006);
          sampleBag.shift(); lastSampleIndex = sampleIndex;
          duckMusic(start,start + duration);
          lastMeowAt = requestedStart; lastMeowSource = 'sample';
          return true;
        } catch (_) {
          if (voice) dispose(voice,true);
          else { try { if (source) source.disconnect(); if (gain) gain.disconnect(); } catch (_) {} }
        }
      }
      const played = playNotes('meow',detail,start,meow);
      if (played) { lastMeowAt = requestedStart; lastMeowSource = 'synth'; duckMusic(start,start + 0.46); }
      return played;
    }
    function play(kind, detail) {
      detail = detail || {}; kind = canonical(kind);
      if (!KINDS.includes(kind) || !remember(kind,detail.id)) return false;
      // Consume IDs before any gate. No historical sound is buffered for resume,
      // sample readiness, rapid-fire spacing, a mute toggle, or tab refocus.
      if (muted || volume <= 0 || hidden() || !unlocked || !context || context.state !== 'running') {
        if (hidden() || (context && context.state !== 'running')) { stopAll(); if (context && context.state !== 'running') unlocked = false; }
        return false;
      }
      const start = context.currentTime + clamp(finite(detail.delay,0),0,1);
      if (kind === 'meow' || (kind === 'found' && samples.length)) return playMeow(detail,start);
      return playNotes(kind,detail,start,null);
    }
    function setMuted(value) { muted = !!value; if (muted) stopAll(); updateGain(); return muted; }
    function setVolume(value) { volume = clamp(finite(value,volume),0,1); if (!volume) stopAll(); updateGain(); return volume; }
    function resetMatch() { stopAll(); seen.clear(); }
    function getState() {
      return Object.freeze({muted,volume,unlocked,contextCreated:!!context,activeVoices:voices.size,
        rememberedIds:seen.size,maxVoices:MAX_VOICES,activeMeows:meows.size,retiringMeows:retiringMeows.size,maxMeows:MAX_MEOWS,
        samplesStatus,loadedSamples:samples.length,failedSamples,lastMeowSource});
    }
    // Protect delayed notes even if the app's own visibility handler runs later.
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange',() => { if (hidden()) stopAll(); updateGain(); });
    }
    return Object.freeze({unlockFromGesture,loadSamples,preload:loadSamples,play,setMuted,setVolume,stopAll,resetMatch,getState});
  }
  return Object.freeze({create,score,softLimit,kinds:KINDS,
    constants:Object.freeze({MAX_VOICES,ID_LIMIT,DEFAULT_VOLUME,MASTER_GAIN,LIMITER_INPUT_RANGE,MAX_MEOWS,MEOW_SPACING,MEOW_REPLACE_FADE,SAMPLE_GAIN,SAMPLE_GAIN_LIMIT,MUSIC_BED_GAIN,MUSIC_DUCK_GAIN})});
});
