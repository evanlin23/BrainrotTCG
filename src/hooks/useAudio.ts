import { useCallback, useRef } from 'react';

export interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

/**
 * Hook for managing audio playback with cleanup
 */
export const useAudio = () => {
  const activeAudioRef = useRef<HTMLAudioElement[]>([]);

  /**
   * Play audio (at `volume`, 0 to 1) and automatically clean up when finished
   */
  const playAndCleanup = useCallback((audio: HTMLAudioElement, volume = 1) => {
    const clone = audio.cloneNode() as HTMLAudioElement;
    clone.volume = volume;
    activeAudioRef.current.push(clone);

    clone.onended = () => {
      clone.src = '';
      activeAudioRef.current = activeAudioRef.current.filter(a => a !== clone);
    };

    clone.play().catch(() => {});
    return clone;
  }, []);

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
  };
};
