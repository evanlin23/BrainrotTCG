// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudio } from './useAudio';

type Audio = ReturnType<typeof useAudio>;
let audio: Audio;
const Probe = ({ onRender }: { onRender: (hook: Audio) => void }) => {
  onRender(useAudio());
  return null;
};

let load: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); // not in jsdom
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe onRender={(hook) => (audio = hook)} />));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preloading sounds', () => {
  it('downloads at once by default', () => {
    const [sound] = audio.preloadAudio(['/a.mp3']);
    expect(sound.preload).toBe('auto');
    expect(load).toHaveBeenCalledOnce();
  });

  it('with defer, downloads nothing until loadDeferred raises preload, skipping cleaned-up sounds', () => {
    const sounds = audio.preloadAudio(['/a.mp3', '/b.mp3', '/c.mp3'], { defer: true });
    expect(sounds.map((s) => s.preload)).toEqual(['none', 'none', 'none']);
    expect(load).not.toHaveBeenCalled();

    audio.cleanupAudio([sounds[2]]);
    audio.loadDeferred(sounds);
    audio.loadDeferred(sounds);
    // Raising preload resumes the deferred download; load() would abort it and fetch again.
    expect(load).not.toHaveBeenCalled();
    expect(sounds.map((s) => s.preload)).toEqual(['auto', 'auto', 'none']);
  });
});
