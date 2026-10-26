// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_FLIP_SRC } from '../constants/audio';
import { useAudio } from './useAudio';

type Audio = ReturnType<typeof useAudio>;
let audio: Audio;
const Probe = ({ onRender }: { onRender: (hook: Audio) => void }) => {
  onRender(useAudio());
  return null;
};

let load: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); // not in jsdom
  root = createRoot(document.createElement('div'));
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

describe('playing sounds', () => {
  it('scales the volume by the sound\'s gain, and leaves an unknown sound at the level', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const [flip, other] = audio.preloadAudio([CARD_FLIP_SRC, '/other.mp3']);
    expect(audio.playAndCleanup(flip, 0.5).volume).toBeCloseTo(0.4);
    expect(audio.playAndCleanup(other, 0.5).volume).toBe(0.5);
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('owned playback clones', () => {
  const pausedClones = () => pause.mock.contexts as HTMLAudioElement[];
  const play = (impl: () => Promise<void> = () => Promise.resolve()) => vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(impl);

  it('keeps a clone that is playing, and releases it when it ends', () => {
    play();
    const [sound] = audio.preloadAudio(['/a.mp3']);
    const clone = audio.playAndCleanup(sound);
    expect(pause).not.toHaveBeenCalled();
    expect(clone.getAttribute('src')).toBe('/a.mp3');
    clone.dispatchEvent(new Event('ended'));
    expect(pausedClones()).toEqual([clone]);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('releases a clone on a media error', () => {
    play();
    const [sound] = audio.preloadAudio(['/a.mp3']);
    const clone = audio.playAndCleanup(sound);
    clone.dispatchEvent(new Event('error'));
    expect(pausedClones()).toEqual([clone]);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('releases a clone whose play is rejected', async () => {
    play(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    const [sound] = audio.preloadAudio(['/a.mp3']);
    const clone = audio.playAndCleanup(sound);
    await Promise.resolve();
    expect(pausedClones()).toEqual([clone]);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('stops every clone still playing on stopAll, and leaves originals and foreign audio alone', () => {
    play();
    const [one, two] = audio.preloadAudio(['/a.mp3', '/b.mp3']);
    const foreign = new Audio('/foreign.mp3');
    const first = audio.playAndCleanup(one);
    const second = audio.playAndCleanup(two);
    audio.stopAll();
    expect(pausedClones()).toEqual([first, second]);
    expect([first, second].map((c) => c.getAttribute('src'))).toEqual(['', '']);
    expect([one, two, foreign].map((a) => a.getAttribute('src'))).toEqual(['/a.mp3', '/b.mp3', '/foreign.mp3']);
  });

  it("stops only its own clones when another instance is playing too", () => {
    play();
    let other!: Audio;
    const otherRoot = createRoot(document.createElement('div'));
    act(() => otherRoot.render(<Probe onRender={(hook) => (other = hook)} />));
    const [mine] = audio.preloadAudio(['/a.mp3']);
    const [theirs] = other.preloadAudio(['/b.mp3']);
    const myClone = audio.playAndCleanup(mine);
    const theirClone = other.playAndCleanup(theirs);

    audio.stopAll();

    expect(pausedClones()).toEqual([myClone]);
    expect(theirClone.getAttribute('src')).toBe('/b.mp3');
    act(() => otherRoot.unmount());
    expect(pausedClones()).toEqual([myClone, theirClone]);
  });

  it('is safe to stop and release twice, and a released clone ending later does nothing more', async () => {
    play();
    const [sound] = audio.preloadAudio(['/a.mp3']);
    const clone = audio.playAndCleanup(sound);
    audio.stopAll();
    audio.stopAll();
    clone.dispatchEvent(new Event('ended'));
    clone.dispatchEvent(new Event('error'));
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('stops what is still playing when the component unmounts', () => {
    play();
    const [sound] = audio.preloadAudio(['/a.mp3']);
    const clone = audio.playAndCleanup(sound);
    act(() => root.unmount());
    expect(pausedClones()).toEqual([clone]);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('does not play or retain a clone when playAndCleanup is called after unmount', () => {
    const playSpy = play();
    const [sound] = audio.preloadAudio(['/a.mp3']);
    act(() => root.unmount());
    playSpy.mockClear();
    pause.mockClear();

    const clone = audio.playAndCleanup(sound);
    expect(playSpy).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();

    audio.stopAll();
    expect(pause).not.toHaveBeenCalled();
    expect(clone).toBeInstanceOf(HTMLAudioElement);
  });
});
