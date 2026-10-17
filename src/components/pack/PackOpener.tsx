import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CardWithMeta } from '../cards/Card';
import type { Settings } from '../../types';
import type { SetDefinition } from '../../engine';
import { openPack, prefetchNextPack, type OpenedPack, type PullRef } from '../../game/pulls';
import { holdLive } from '../../game/admission';
import { reloadPage } from '../../game/reload';
import { whenIdle } from '../../game/idle';
import { triggerRarityConfetti, triggerHoloSparkles } from '../../utils/confettiEffects';
import { buzz } from '../../utils/motion';
import { usePackCutter } from '../../hooks/usePackCutter';
import { useAudio } from '../../hooks/useAudio';
import { useKeyboardControls } from '../../hooks/useKeyboardControls';
import { usePackHistory } from '../../hooks/usePackHistory';
import { BRAINROT_VOICES, EFFECT_SOUNDS, CARD_FLIP_SRC, EFFECT_DELAY_MS } from '../../constants/audio';
import { effectsLevel } from '../../utils/settings';
import PackCuttingUI from './PackCuttingUI';
import CardRevealUI from './CardRevealUI';
import PackSummaryUI from './PackSummaryUI';
import PackTopBar from './PackTopBar';
import ShowcaseRibbon from './ShowcaseRibbon';
import { revealAnnouncement } from '../cards/cardLabel';
import { REFUSAL_COPY, type PackRefusal } from './refusal';
import { packImageUrl } from '../../content/art';
import { isBigPull, isSpecialReveal, markNew, nextSpecialRevealIndex, revealOrder, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import '../../styles/PackOpener.css';

const Motion = motion;

/**
 * Focus follows the stage (#312) onto a control that just appeared, unless the player has put it
 * somewhere else on the page: only from nowhere (the control it was on just went) or from the pack.
 */
const focusIfFree = (el: HTMLElement | null) => {
  if (!el) return;
  const active = document.activeElement;
  if (!active || active === document.body || active.closest('.pack-opener-container')) el.focus({ preventScroll: true });
};

interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

interface PackOpenerProps {
  /** Called once every card has been revealed. */
  onOpen: (pack: OpenedPack) => void;
  onShare: (pack: OpenedPack) => void;
  /** True while a pack is being opened (its ticket is spent but it isn't recorded yet). */
  onBusyChange?: (busy: boolean) => void;
  /** True from the tear until the player leaves the pack (while its X shows): the app's focus mode. */
  onFocusChange?: (focus: boolean) => void;
  /**
   * True while a revealed big pull is being showcased (its ribbon and halo are up), or a skip is on
   * its way to the next one: the app holds its notices.
   */
  onShowcaseChange?: (showcase: boolean) => void;
  set: SetDefinition;
  disabled?: boolean;
  /** No new pack may start (the save changed in another tab); one already opening still finishes. */
  openBlocked?: boolean;
  settings: Settings;
  /** The chosen, unlocked back, shared by the active card and the remaining stack. */
  cardBack?: string;
  /** Whether the collection already had this card before the pack (for the NEW sticker). */
  isOwned?: (cardKey: string) => boolean;
  /** The player closed a reveal with cards still face down; they're recorded anyway, so say so (unless the save failed). */
  onLeaveEarly?: (pack: OpenedPack) => void;
}

const PackOpener = ({ onOpen, onShare, onBusyChange, onFocusChange, onShowcaseChange, set, disabled = false, openBlocked = false, settings, cardBack, isOwned, onLeaveEarly }: PackOpenerProps) => {
  const [isOpening, setIsOpening] = useState(false);
  const [openedPack, setOpenedPack] = useState<OpenedPack | null>(null);
  /** Why the last tear didn't open a pack, shown under it with a way to try again. */
  const [refusal, setRefusal] = useState<PackRefusal | null>(null);
  const [openedCards, setOpenedCards] = useState<CardWithMeta[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPackCut, setIsPackCut] = useState(false);
  const [preloadedAssets, setPreloadedAssets] = useState<PreloadedAssets | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [revealLocked, setRevealLocked] = useState(false);
  const [celebratingCardId, setCelebratingCardId] = useState<CardWithMeta['uniqueId'] | null>(null);
  const [skipping, setSkipping] = useState(false);
  const packDesign = packImageUrl(set.id);
  const [hasMovedMouse, setHasMovedMouse] = useState(false);
  const effectsVolume = effectsLevel(settings.effectsVolume);
  const pauseBigPulls = settings.pauseBigPulls !== false;

  const { playAndCleanup, preloadAudio, loadDeferred, cleanupAudio, playRandom } = useAudio();

  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInteractionRef = useRef<() => void>(() => {});
  // Set synchronously before React renders: rapid taps and held keys share the same guard.
  const revealLockedUntilRef = useRef(0);
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const skippingRef = useRef(false);
  /** Whether this pack has been handed to onOpen; a pack is recorded once, however it's finished. */
  const recordedRef = useRef(false);
  /** The player left a torn pack while its ticket was still being worked out: keep it, don't show it. */
  const leaveOpeningRef = useRef(false);
  const [leavingOpen, setLeavingOpen] = useState(false);
  /** What a ticket that lands after the player left needs, as of the latest render. */
  const landingRef = useRef({ onOpen, onLeaveEarly, resetCutState: () => {} });
  /** Whether a tear may still spend its ticket, as of the latest render (see handleCutComplete). */
  const openBlockedRef = useRef(openBlocked);

  const startOpening = useCallback(async () => {
    let pack: OpenedPack;
    try {
      // Usually instant: the ticket was mined while the pack was on screen.
      pack = await openPack(set);
    } catch (error) {
      console.error('Could not open pack', error);
      setIsPackCut(false);
      if (leaveOpeningRef.current) {
        // Already back on the packs screen: nothing was dealt, so there's nothing to say.
        leaveOpeningRef.current = false;
        setLeavingOpen(false);
        landingRef.current.resetCutState();
      } else {
        setRefusal('failed');
      }
      return;
    }
    if (leaveOpeningRef.current) {
      // The player left while it was on its way: the pack is recorded face up, as leaving a reveal
      // early does, and the "Pack kept" notice says where its cards went.
      leaveOpeningRef.current = false;
      setLeavingOpen(false);
      const { onOpen: record, onLeaveEarly: kept, resetCutState: reset } = landingRef.current;
      const dealt: OpenedPack = { ...pack, cards: pack.cards.map((card) => ({ ...card, isRevealed: true })) };
      record(dealt);
      kept?.(dealt);
      setIsPackCut(false);
      reset();
      return;
    }
    // Fetched once the reveal is on screen (below), so they don't hold up its card backs.
    const brainrotVoices = preloadAudio(BRAINROT_VOICES, { defer: true });
    const cardFlip = preloadAudio([CARD_FLIP_SRC], { defer: true })[0];
    const effects = preloadAudio(EFFECT_SOUNDS, { defer: true });

    setPreloadedAssets({ brainrotVoices, cardFlip, effects });
    recordedRef.current = false;
    setOpenedPack(pack);
    // Shown rarest last, with NEW on cards the collection didn't have yet. The pack itself (and its
    // proof and history) keeps the engine's order.
    setOpenedCards(markNew(revealOrder(pack.cards), (key) => isOwned?.(key) ?? true));
    setCurrentIndex(0);
    setIsOpening(true);
  }, [set, preloadAudio, isOwned]);

  // The reveal's sounds download once it has been drawn and the page is idle, and not at all while
  // effects are muted (each one only plays when effectsVolume > 0).
  const effectsOn = effectsVolume > 0;
  useEffect(() => {
    if (!isOpening || !preloadedAssets || !effectsOn) return;
    return whenIdle(() => loadDeferred([preloadedAssets.cardFlip, ...preloadedAssets.effects, ...preloadedAssets.brainrotVoices]));
  }, [isOpening, preloadedAssets, loadDeferred, effectsOn]);

  // Mine the next pack's ticket while this one is on screen.
  useEffect(() => {
    if (!isOpening) prefetchNextPack(set);
  }, [isOpening, set]);

  // From the tear on, the ticket is spent: the app mustn't swap sets (or open a sheet over it) until
  // the pack is recorded. The ticket can still be mining here on a slow phone.
  // The summary comes after it's recorded, so it isn't busy (focus mode still hides the chrome there).
  // It changes before paint, as the stage below lets go of its size.
  const busy = (isOpening && !showSummary) || (isPackCut && !isOpening);
  useLayoutEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  // Mining taking a while: say so, rather than leave a torn pack sitting still.
  const [slowOpen, setSlowOpen] = useState(false);
  /**
   * A press on the pack just missed the tear line ('miss'), or tapped it without swiping ('tap'), so
   * it shows where, or how, to swipe for a moment.
   */
  const [nudging, setNudging] = useState<false | 'miss' | 'tap'>(false);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback((kind: 'miss' | 'tap') => {
    setNudging(kind);
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(() => setNudging(false), 1800);
  }, []);
  const nudgeMiss = useCallback(() => nudge('miss'), [nudge]);
  const nudgeTap = useCallback(() => nudge('tap'), [nudge]);
  useEffect(() => {
    if (!isPackCut || isOpening) return;
    const timer = window.setTimeout(() => setSlowOpen(true), 1200);
    return () => {
      window.clearTimeout(timer);
      setSlowOpen(false);
    };
  }, [isPackCut, isOpening]);

  const handleCutComplete = useCallback(() => {
    setIsPackCut(true);
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    setRefusal(null);
    openTimeoutRef.current = window.setTimeout(() => {
      openTimeoutRef.current = null;
      if (openBlockedRef.current) {
        // Another tab changed the save since the tear: put the pack back sealed rather than spend a
        // ticket this tab can't store, and say why.
        setIsPackCut(false);
        landingRef.current.resetCutState();
        setRefusal('blocked');
        return;
      }
      // Started: from here the ticket is spent, so leaving keeps the pack rather than cancelling it.
      void startOpening();
    }, 460);
  }, [startOpening]);

  const {
    packRef,
    isCutting,
    isPressing,
    cutPoints,
    sparks,
    resetCutState,
    completeCut,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    endCutAttempt,
    cleanup: cleanupCutter,
  } = usePackCutter({
    onCutComplete: handleCutComplete,
    isOpening,
    isPackCut,
    volume: effectsVolume,
    particlesEnabled: settings.particlesEnabled,
    disabled: disabled || openBlocked,
    onMiss: nudgeMiss,
    onSeamTap: nudgeTap,
  });

  useEffect(() => {
    landingRef.current = { onOpen, onLeaveEarly, resetCutState };
  });

  useEffect(() => {
    openBlockedRef.current = openBlocked;
  });

  // From the first swipe until the summary, re-opening and checking other pulls start no new ticket
  // (one already mining finishes), so this pack's ticket and animations get the device; the summary
  // then holds them until its cards have decoded (PackSummaryUI). Not while a
  // sheet covers the pack: a check opened there (a shared pull or profile link) shouldn't wait for a
  // reveal it hides. This pack's own ticket still holds while it mines (ticketMiner).
  const live = !disabled && (isCutting || (isOpening && !showSummary) || (isPackCut && !isOpening));
  useEffect(() => (live ? holdLive() : undefined), [live]);

  // A pack that refused to open can be torn again, as its refusal offers.
  useEffect(() => {
    if (refusal) resetCutState();
  }, [refusal, resetCutState]);

  /**
   * The Open pack button (and Space or Enter with focus nowhere in particular): exactly a finished
   * swipe, through the same cut, tear and ticket. A save another tab changed opens nothing, and says so.
   */
  const handleOpen = useCallback(() => {
    if (disabled || isPackCut || isOpening) return;
    if (openBlocked) {
      setRefusal('blocked');
      return;
    }
    completeCut();
  }, [disabled, isPackCut, isOpening, openBlocked, completeCut]);

  /** Set when the player goes back to the sealed pack, so the Open pack button takes focus once it's there. */
  const focusOpenRef = useRef(false);

  const retryOpen = useCallback(() => {
    if (refusal === 'blocked') {
      reloadPage();
      return;
    }
    // Try again goes as the Open pack button comes back (disabled while the ticket is on its way):
    // focus moves to it rather than falling to the page for the whole wait.
    focusOpenRef.current = true;
    handleOpen();
  }, [refusal, handleOpen]);
  /** The sealed pack's stage, which scrolls on a desktop window (PackOpener.css). */
  const stageRef = useRef<HTMLDivElement>(null);
  // The stage is on its way out when the cards come in, and the reveal must not inherit anything it
  // scrolled to: it goes back to the top as opening starts.
  useLayoutEffect(() => {
    if (isOpening && stageRef.current) stageRef.current.scrollTop = 0;
  }, [isOpening]);
  const openButtonEl = useRef<HTMLButtonElement | null>(null);
  const openButtonRef = useCallback((el: HTMLButtonElement | null) => {
    openButtonEl.current = el;
    if (el && focusOpenRef.current) {
      focusOpenRef.current = false;
      focusIfFree(el);
    }
  }, []);
  // A refusal replaces the button the player was on: its Try again takes focus.
  const retryButtonRef = useCallback((el: HTMLButtonElement | null) => focusIfFree(el), []);

  const clearEffectTimers = useCallback(() => {
    effectTimersRef.current.forEach(clearTimeout);
    effectTimersRef.current.clear();
  }, []);

  const finishPack = useCallback(() => {
    clearEffectTimers();
    skippingRef.current = false;
    setSkipping(false);
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = null;
    revealLockedUntilRef.current = 0;
    setRevealLocked(false);
    setCelebratingCardId(null);
    if (preloadedAssets) {
      cleanupAudio(preloadedAssets.brainrotVoices);
      cleanupAudio([preloadedAssets.cardFlip]);
      cleanupAudio(preloadedAssets.effects);
    }
    setPreloadedAssets(null);
    setIsOpening(false);
    setOpenedPack(null);
    setOpenedCards([]);
    setCurrentIndex(0);
    setIsPackCut(false);
    setShowSummary(false);
    setHasMovedMouse(false);
    resetCutState();
    focusOpenRef.current = true;
  }, [resetCutState, preloadedAssets, cleanupAudio, clearEffectTimers]);

  // What a card shared from the summary links to: this pull (one object, so its proof is signed once).
  const pullRef = useMemo((): PullRef | undefined => openedPack
    ? { setId: openedPack.setId, setVersion: openedPack.setVersion, nonce: openedPack.nonce, publicKeyHex: openedPack.publicKeyHex }
    : undefined, [openedPack]);
  /** The pack as the engine dealt it, face up: what's recorded and shared (the reveal order is only for show). */
  const dealtPack = useCallback((): OpenedPack | null => (openedPack ? { ...openedPack, cards: openedPack.cards.map((card) => ({ ...card, isRevealed: true })) } : null), [openedPack]);

  const recordPack = useCallback(() => {
    const pack = dealtPack();
    if (!pack || recordedRef.current) return;
    recordedRef.current = true;
    onOpen(pack);
  }, [dealtPack, onOpen]);

  const nextCard = useCallback(() => {
    if (pauseBigPulls && performance.now() < revealLockedUntilRef.current) return;
    if (currentIndex < openedCards.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      recordPack();
      setShowSummary(true);
    }
  }, [currentIndex, openedCards, recordPack, pauseBigPulls]);

  /** With the pause enabled, Skip still gives each valuable card its full reveal. */
  const skipAll = useCallback(() => {
    if (disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;
    if (!pauseBigPulls) {
      setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
      recordPack();
      setShowSummary(true);
      return;
    }
    skippingRef.current = true;
    setSkipping(true);
  }, [disabled, pauseBigPulls, openedCards, recordPack]);

  const closeSummary = useCallback(() => {
    finishPack();
  }, [finishPack]);

  /**
   * Any stage of a pack, from the tear to the summary: the pack's X, Escape and browser Back. A torn
   * pack the player left while its ticket is on its way already looks sealed again; it stays busy
   * (isPackCut) until the ticket lands and is recorded. A pack another tab's save kept sealed isn't
   * one: the app's banner and Settings, which offer the same reload, stay in reach.
   */
  const stageInPack = (isPackCut && !leavingOpen) || isOpening || refusal === 'failed';

  // Focus mode (#312): the app's chrome stays out of the way for the whole pack, summary included, and
  // comes back as soon as the player leaves it, even while a left pack's ticket is still on its way. It
  // changes before paint, in the same frame as the stage below takes or lets go of its size.
  useLayoutEffect(() => onFocusChange?.(stageInPack), [stageInPack, onFocusChange]);
  // Unmounted mid-pack (the set changed under its summary): the pack is gone, so the chrome comes back.
  // onFocusChange is a state setter, so this runs on unmount only, never between renders.
  useEffect(() => () => onFocusChange?.(false), [onFocusChange]);

  // The pack is fitted to its stage, and the stage would grow into the room the chrome leaves as the
  // pack tears: the pack got bigger as it opened. The stage keeps the size and place it had at rest
  // until the pack is done, unless the window itself resizes, or chrome that wasn't there at rest comes
  // in above or below it (a new player's first pack, left while its ticket is on its way, brings the
  // set picker and tabs): either fits the pack to the room it has now. A pack left while its ticket is
  // on its way is done when the ticket lands (the card guide comes back then).
  const holdStage = stageInPack || busy;
  /** Moves the held stage back to its place at rest as the room around it moves. */
  const followRoomRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const room = stage?.parentElement;
    if (!holdStage || !stage || !room) return;
    const height = parseFloat(getComputedStyle(stage).height);
    if (!(height > 0)) return; // Not laid out (jsdom).
    const rest = room.getBoundingClientRect();
    let held = true;
    stage.style.flex = 'none';
    stage.style.height = `${height}px`;
    const follow = () => {
      if (!held) return;
      const now = room.getBoundingClientRect();
      // Held there, the stage would run under that chrome.
      if (now.top > rest.top + 0.5 || now.height < rest.height - 0.5) release();
      else stage.style.top = `${rest.top - now.top}px`;
    };
    followRoomRef.current = follow;
    const observer = new ResizeObserver(follow);
    observer.observe(room);
    const release = () => {
      held = false;
      followRoomRef.current = null;
      observer.disconnect();
      window.removeEventListener('resize', release);
      stage.style.flex = stage.style.height = stage.style.top = '';
    };
    window.addEventListener('resize', release);
    return release;
  }, [holdStage]);
  // The room moves as the chrome above it goes or comes back, in the app's render of the focus change
  // above, which ends before this task does: the held stage follows it in the same task. The observer
  // catches anything else that moves the room, before paint.
  useLayoutEffect(() => {
    const follow = followRoomRef.current;
    if (follow) queueMicrotask(follow);
  }, [stageInPack]);

  /**
   * Back to the packs screen from any stage, keeping whatever the pack already spent. It works during
   * a big pull's pause too (ending its celebration): the pause holds the cards, not the player.
   */
  const leavePack = useCallback(() => {
    if (isOpening && !showSummary) {
      // Mid-reveal: the pack is recorded with every card, as finishing it would.
      const leftEarly = openedCards.some((card) => !card.isRevealed);
      const pack = dealtPack();
      recordPack();
      finishPack();
      if (leftEarly && pack) onLeaveEarly?.(pack);
    } else if (isOpening) {
      // The summary: already recorded.
      finishPack();
    } else if (isPackCut) {
      if (openTimeoutRef.current) {
        // Torn, but its ticket isn't spent yet: put the pack back sealed.
        window.clearTimeout(openTimeoutRef.current);
        openTimeoutRef.current = null;
        setIsPackCut(false);
        resetCutState();
        focusOpenRef.current = true;
      } else if (!leaveOpeningRef.current) {
        // Its ticket is spent and still on its way: startOpening records it when it lands.
        leaveOpeningRef.current = true;
        setLeavingOpen(true);
        resetCutState();
        focusOpenRef.current = true;
      }
    } else if (refusal) {
      setRefusal(null);
      resetCutState();
      focusOpenRef.current = true;
    }
  }, [isOpening, showSummary, isPackCut, refusal, openedCards, dealtPack, recordPack, finishPack, onLeaveEarly, resetCutState]);

  // Back on the sealed pack with its button already there (a torn pack put back, a refusal dismissed):
  // the X the player left by has gone, so focus goes to Open pack rather than the page.
  useEffect(() => {
    if (!focusOpenRef.current || stageInPack || !openButtonEl.current) return;
    focusOpenRef.current = false;
    focusIfFree(openButtonEl.current);
  });

  // Like skipAll: an open sheet disables the opener, so a stray press or key behind it does nothing.
  const leaveFromUi = useCallback(() => {
    if (!disabled) leavePack();
  }, [disabled, leavePack]);

  // Browser Back goes through the same guard: behind a sheet it leaves nothing, and the pack keeps its entry.
  usePackHistory(stageInPack, leaveFromUi);

  const handleFlip = useCallback(() => {
    const currentCard = openedCards[currentIndex];
    if (!currentCard || currentCard.isRevealed || !preloadedAssets) return;

    if (isSpecialReveal(currentCard)) {
      // The celebration always plays; the setting controls only the input lock.
      setCelebratingCardId(currentCard.uniqueId);
      revealLockedUntilRef.current = pauseBigPulls ? performance.now() + SPECIAL_REVEAL_DURATION_MS : 0;
      setRevealLocked(pauseBigPulls);
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = setTimeout(() => {
        revealLockedUntilRef.current = 0;
        celebrationTimerRef.current = null;
        setRevealLocked(false);
        setCelebratingCardId(null);
      }, SPECIAL_REVEAL_DURATION_MS);
    }

    if (effectsVolume > 0) {
      playAndCleanup(preloadedAssets.cardFlip, effectsVolume);
      const effects = preloadedAssets.effects;
      const timer = setTimeout(() => {
        effectTimersRef.current.delete(timer);
        playRandom(effects, effectsVolume);
      }, EFFECT_DELAY_MS);
      effectTimersRef.current.add(timer);
    }

    setOpenedCards(openedCards.map((card, index) => index === currentIndex ? { ...card, isRevealed: true } : card));

    // A short buzz on phones: a tick for any card, a double for big pulls. None under reduced motion.
    buzz(isBigPull(currentCard) ? [18, 60, 30] : 8);

    if (settings.particlesEnabled) {
      // A finish or misprint gets at least an Epic's confetti.
      const modified = !!currentCard.finish || !!currentCard.misprint;
      const plainish = currentCard.rarity === 'COMMON' || currentCard.rarity === 'UNCOMMON' || currentCard.rarity === 'RARE';
      triggerRarityConfetti(modified && plainish ? 'EPIC' : currentCard.rarity);
      if (currentCard.isHolo) {
        triggerHoloSparkles();
      }
    }
  }, [openedCards, currentIndex, preloadedAssets, playAndCleanup, playRandom, settings, effectsVolume, pauseBigPulls]);

  // A skip is a short sequence: mount each valuable card face down, flip it, wait for its lock,
  // then move to the next. Already revealed cards don't repeat their celebration.
  useEffect(() => {
    if (!skipping || (revealLocked && pauseBigPulls) || !isOpening || showSummary || disabled) return;
    // Give a newly mounted card a frame face down before starting its flip.
    const frame = requestAnimationFrame(() => {
      const nextIndex = pauseBigPulls ? nextSpecialRevealIndex(openedCards) : -1;
      if (nextIndex === -1) {
        setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
        recordPack();
        setShowSummary(true);
        skippingRef.current = false;
        setSkipping(false);
      } else if (currentIndex !== nextIndex) {
        setOpenedCards(openedCards.map((card, index) => index < nextIndex ? { ...card, isRevealed: true } : card));
        setCurrentIndex(nextIndex);
      } else {
        handleFlip();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [skipping, revealLocked, pauseBigPulls, isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, recordPack]);

  const handleInteraction = useCallback(() => {
    if (!isOpening || showSummary || disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;

    const currentItem = openedCards[currentIndex];
    if (currentItem && !currentItem.isRevealed) {
      handleFlip();
    } else {
      nextCard();
    }
  }, [isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, nextCard, pauseBigPulls]);

  // Held Space reads the current interaction without a stale closure.
  useEffect(() => {
    handleInteractionRef.current = handleInteraction;
  }, [handleInteraction]);

  // Use keyboard controls hook
  useKeyboardControls({
    isOpening,
    showSummary,
    disabled,
    onCloseSummary: closeSummary,
    onOpenPack: handleOpen,
    handleInteractionRef,
    inPack: stageInPack,
    onLeave: leaveFromUi,
  });

  // Play "what kind of brainrot" when a new card appears
  useEffect(() => {
    if (isOpening && preloadedAssets && openedCards[currentIndex] && !openedCards[currentIndex].isRevealed && effectsVolume > 0) {
      const timer = setTimeout(() => {
        playRandom(preloadedAssets.brainrotVoices, effectsVolume);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [isOpening, currentIndex, preloadedAssets, openedCards, playRandom, effectsVolume]);

  // Hide mouse hint after user moves mouse
  useEffect(() => {
    if (!isOpening || hasMovedMouse) return;
    const handleMouseMove = () => setHasMovedMouse(true);
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpening, hasMovedMouse]);

  // Pointer event listeners for cutting. Losing focus or hiding the page (switching apps, often
  // without a pointerup) ends a stroke and drops its pending frame, sparks and sound (#266).
  useEffect(() => {
    const endWhenHidden = () => {
      if (document.visibilityState === 'hidden') endCutAttempt();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', endCutAttempt);
    document.addEventListener('visibilitychange', endWhenHidden);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', endCutAttempt);
      document.removeEventListener('visibilitychange', endWhenHidden);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerEnd, endCutAttempt]);

  // Unmounted mid-reveal (the set list changed under it): the pack still goes to the collection.
  const recordOnUnmountRef = useRef(recordPack);
  useEffect(() => {
    recordOnUnmountRef.current = recordPack;
  }, [recordPack]);

  useEffect(() => () => recordOnUnmountRef.current(), []);

  // Cleanup on unmount
  useEffect(() => () => {
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    clearEffectTimers();
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    cleanupCutter();
  }, [cleanupCutter, clearEffectTimers]);

  const currentCard = openedCards[currentIndex];
  // The showcase lasts as long as the celebration: its timer, moving on, the X or the summary ends it.
  const showcase = isOpening && !showSummary && !!currentCard?.isRevealed
    && celebratingCardId === currentCard.uniqueId && isSpecialReveal(currentCard);
  // A skip still heading for a big pull keeps the hold between showcases, so a notice can't flash
  // in the frames it takes to reach the next one (#460).
  const holdNotices = showcase || (skipping && pauseBigPulls && isOpening && !showSummary && nextSpecialRevealIndex(openedCards) !== -1);
  // Before paint, so a notice can't flash in the frame the ribbon first shows.
  useLayoutEffect(() => {
    if (!holdNotices) return;
    onShowcaseChange?.(true);
    return () => onShowcaseChange?.(false);
  }, [holdNotices, onShowcaseChange]);

  const waiting = slowOpen && isPackCut && !isOpening && !leavingOpen;
  // The pack's one polite live region, for every stage: why a pack stayed sealed, the wait for a slow
  // ticket, and each card as it turns face up (never before, so nothing is spoiled). It is always
  // mounted, so a change is read. The summary says itself: its heading takes focus.
  const announcement = refusal
    ? REFUSAL_COPY[refusal].message
    : waiting
      ? 'Opening the pack…'
      : isOpening && !showSummary && currentCard
        ? revealAnnouncement(currentCard, currentIndex, openedCards.length) ?? ''
        : '';

  return (
    <div className="pack-opener-container">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {stageInPack && (
        <PackTopBar
          onLeave={leaveFromUi}
          progress={isOpening && !showSummary ? { index: currentIndex, total: openedCards.length } : undefined}
          showcase={showcase ? <ShowcaseRibbon card={currentCard} holding={revealLocked && pauseBigPulls} /> : undefined}
        />
      )}
      {/* The torn pack flies off as the first card back fades in, not before it: waiting for the exit
          left an empty stage between the tear and the reveal (#312 P2-6). popLayout lifts the leaving
          pack out of the flow, so the two overlap in place. */}
      <AnimatePresence mode="popLayout">
        {!isOpening ? (
          <Motion.div
            key="pack"
            ref={stageRef}
            initial={{ y: '-100vh', opacity: 0, rotate: -10 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            // Quick, on its own timing: the drop-in spring's long tail left the screen blank before the reveal.
            exit={{ scale: 1.25, opacity: 0, transition: { duration: 0.25, ease: 'easeIn' } }}
            transition={{
              type: 'spring',
              stiffness: 80,
              damping: 12,
              mass: 1
            }}
            className="pack-display"
          >
            <PackCuttingUI
              packRef={packRef}
              packDesign={packDesign}
              set={set}
              isCutting={isCutting}
              pressing={isPressing}
              isPackCut={isPackCut && !leavingOpen}
              waiting={waiting}
              refusal={refusal}
              onOpen={handleOpen}
              onRetry={retryOpen}
              openButtonRef={openButtonRef}
              retryButtonRef={retryButtonRef}
              nudging={nudging === 'miss'}
              tapped={nudging === 'tap'}
              cutPoints={cutPoints}
              sparks={sparks}
            />
          </Motion.div>
        ) : (
          <Motion.div
            key="opening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="card-reveal-area"
          >
            {!showSummary ? (
              <CardRevealUI
                currentCard={currentCard}
                cardBack={cardBack}
                currentIndex={currentIndex}
                totalCards={openedCards.length}
                hasMovedMouse={hasMovedMouse}
                onInteraction={handleInteraction}
                onSkip={skipAll}
                revealLocked={revealLocked && pauseBigPulls}
                celebrating={celebratingCardId === currentCard?.uniqueId}
                skipping={skipping}
                setName={set.name}
              />
            ) : (
              <PackSummaryUI
                openedCards={openedCards}
                set={set}
                onClose={closeSummary}
                onShare={openedPack ? () => onShare(dealtPack()!) : undefined}
                pack={pullRef}
                holdOptional={!disabled}
              />
            )}
          </Motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PackOpener;
