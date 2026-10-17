"use client";
/**
 * Short tones for a hands-free capture: the person being measured looks at the flash, not the screen, so the
 * countdown and the outcome are heard. The audio context starts on a tap (browsers allow sound only after one).
 */
let audio: AudioContext | null = null;

export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

export function beep(freqHz: number, ms = 120) {
  if (!audio) return;
  try {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freqHz;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    const t = audio.currentTime;
    osc.start(t);
    osc.stop(t + ms / 1000);
  } catch {
    /* no sound: the screen still shows the countdown */
  }
}

/** countdown tick, a good capture (two high tones) and a retake (one low tone) */
export const TONES = { tick: 660, good: 990, retake: 220 } as const;
