import { useCallback, useEffect, useRef } from 'react';
import { soundVolume } from '../constants/audio';

export interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

/**
 * Hook for managing audio playback with cleanup
 */
export const useAudio = () => {
  // The playback clones this hook made and has not released yet; nothing else is ever stopped here.
  const activeAudioRef = useRef<Set<HTMLAudioElement>>(new Set());
  const mountedRef = useRef(true);

  /** Stops and releases one owned clone. Safe to repeat: a clone already released is left alone. */
  const disposeClone = useCallback((clone: HTMLAudioElement) => {
    if (!activeAudioRef.current.delete(clone)) return;
    clone.onended = null;
    clone.onerror = null;
    clone.pause();
    clone.src = '';
  }, []);

  /** Stops every clone still playing, for a pack that is finished or left. */
  const stopAll = useCallback(() => {
    [...activeAudioRef.current].forEach(disposeClone);
  }, [disposeClone]);

  // Unmounting ends whatever is still playing.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopAll();
    };
  }, [stopAll]);

  /**
   * Play audio (at `volume`, 0 to 1, scaled by the sound's own gain) and release it when it ends,
   * fails to play or errors
   */
  const playAndCleanup = useCallback((audio: HTMLAudioElement, volume = 1) => {
    const clone = audio.cloneNode() as HTMLAudioElement;
    clone.volume = soundVolume(audio.getAttribute('src'), volume);
    if (!mountedRef.current) return clone;
    activeAudioRef.current.add(clone);

    clone.onended = () => disposeClone(clone);
    clone.onerror = () => disposeClone(clone);

    clone.play().catch(() => disposeClone(clone));
    return clone;
  }, [disposeClone]);

  /**
   * Preload multiple audio files. With `defer`, nothing downloads until `loadDeferred` (a sound
   * played before then still plays, fetched as it starts).
   */
  const preloadAudio = useCallback((sources: string[], { defer = false } = {}): HTMLAudioElement[] => {
    return sources.map(src => {
      const audio = new Audio(src);
      audio.preload = defer ? 'none' : 'auto';
      if (!defer) audio.load();
      return audio;
    });
  }, []);

  /**
   * Download audio preloaded with `defer`. Skips elements already cleaned up.
   */
  const loadDeferred = useCallback((audioElements: HTMLAudioElement[]) => {
    audioElements.forEach(audio => {
      if (!audio.getAttribute('src') || audio.preload === 'auto') return;
      // Raising preload starts the deferred download in place; load() would abort and refetch it.
      audio.preload = 'auto';
    });
  }, []);

  /**
   * Clean up audio elements
   */
  const cleanupAudio = useCallback((audioElements: HTMLAudioElement[]) => {
    audioElements.forEach(audio => {
      audio.pause();
      audio.src = '';
    });
  }, []);

  /**
   * Play a random audio from an array
   */
  const playRandom = useCallback((audioArray: HTMLAudioElement[], volume = 1) => {
    if (audioArray.length === 0) return;
    const randomAudio = audioArray[Math.floor(Math.random() * audioArray.length)];
    playAndCleanup(randomAudio, volume);
  }, [playAndCleanup]);

  return {
    playAndCleanup,
    preloadAudio,
    loadDeferred,
    cleanupAudio,
    playRandom,
    stopAll,
  };
};
