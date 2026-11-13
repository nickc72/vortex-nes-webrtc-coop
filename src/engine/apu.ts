import { SoundCueType } from './types';

class VortexAPU {
  private ctx: AudioContext | null = null;
  public muted: boolean = false;
  public volume: number = 0.25;

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public playCue(cue: SoundCueType): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    switch (cue) {
      case 'SHOOT_RIFLE': {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.065);
        gain.gain.setValueAtTime(this.volume * 0.45, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.065);
        break;
      }
      case 'SHOOT_SPREAD': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(680, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.09);
        gain.gain.setValueAtTime(this.volume * 0.55, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.09);
        break;
      }
      case 'SHOOT_LASER': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(980, now);
        osc.frequency.linearRampToValueAtTime(340, now + 0.13);
        gain.gain.setValueAtTime(this.volume * 0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.13);
        break;
      }
      case 'SHOOT_CRUSH': {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(75, now + 0.14);
        gain.gain.setValueAtTime(this.volume * 0.65, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.14);
        break;
      }
      case 'JUMP': {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(460, now + 0.085);
        gain.gain.setValueAtTime(this.volume * 0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.085);
        break;
      }
      case 'POWERUP': {
        const notes = [440, 554.37, 659.25, 880];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, now + idx * 0.055);
          noteGain.gain.setValueAtTime(this.volume * 0.45, now + idx * 0.055);
          noteGain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.07);
          osc.connect(noteGain);
          noteGain.connect(ctx.destination);
          osc.start(now + idx * 0.055);
          osc.stop(now + idx * 0.055 + 0.07);
        });
        break;
      }
      case 'HIT_ENEMY': {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + 0.045);
        gain.gain.setValueAtTime(this.volume * 0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.045);
        break;
      }
      case 'EXPLODE_SMALL': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(160, now);
        osc.frequency.exponentialRampToValueAtTime(38, now + 0.18);
        gain.gain.setValueAtTime(this.volume * 0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.18);
        break;
      }
      case 'EXPLODE_BOSS': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(28, now + 0.55);
        gain.gain.setValueAtTime(this.volume * 0.85, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.55);
        break;
      }
      case 'PLAYER_DEATH': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(340, now);
        osc.frequency.linearRampToValueAtTime(75, now + 0.32);
        gain.gain.setValueAtTime(this.volume * 0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.32);
        break;
      }
      case 'VICTORY': {
        const fanfare = [523.25, 659.25, 783.99, 1046.5];
        fanfare.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, now + idx * 0.09);
          noteGain.gain.setValueAtTime(this.volume * 0.5, now + idx * 0.09);
          noteGain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.16);
          osc.connect(noteGain);
          noteGain.connect(ctx.destination);
          osc.start(now + idx * 0.09);
          osc.stop(now + idx * 0.09 + 0.16);
        });
        break;
      }
    }
  }
}

export const apu = new VortexAPU();
