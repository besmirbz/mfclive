// MFCLIVE | © 2025 Besmir Pepa
// Shared audio utility — served at /audio-util.js
// Smoothly ramps an HTMLAudioElement's volume from its current level to
// toVol over durationMs, then pauses if the target is 0.
function fadeAudio(audio, toVol, durationMs) {
  toVol = Math.max(0, Math.min(1, toVol));
  durationMs = Math.max(0, durationMs);
  clearInterval(audio._fadeTimer);
  if (durationMs === 0) {
    audio.volume = toVol;
    if (toVol === 0) audio.pause();
    return;
  }
  const steps = Math.max(1, Math.round(durationMs / 16));
  const fromVol = audio.volume;
  let step = 0;
  audio._fadeTimer = setInterval(() => {
    step++;
    audio.volume = Math.max(0, Math.min(1, fromVol + (toVol - fromVol) * (step / steps)));
    if (step >= steps) {
      clearInterval(audio._fadeTimer);
      if (toVol === 0) audio.pause();
    }
  }, durationMs / steps);
}
