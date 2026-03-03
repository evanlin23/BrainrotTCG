import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import Card, { CardWithMeta } from './Card';
import CardViewerModal from './CardViewerModal';
import pack1 from '../assets/packs/pack1.png';
import pack2 from '../assets/packs/pack2.png';
import type { Card as CardType } from '../data/cards';

const PACK_DESIGNS = [pack1, pack2];
import whatBrainrotOriginal from '../assets/voices/what-brainrot.mp3';
import cardFlipSrc from '../assets/audio/Card-flip-sound-effect.mp3';

// Auto-scan for ElevenLabs voice files
const elevenLabsVoices = import.meta.glob('../assets/voices/ElevenLabs_*.mp3', { eager: true }) as Record<string, { default: string }>;
const BRAINROT_VOICES = [
    whatBrainrotOriginal,
    ...Object.values(elevenLabsVoices).map(m => m.default)
];
import fairyDustSrc from '../assets/audio/fairy-dust-sound-effect.mp3';
import wooshSrc from '../assets/audio/woosh.mp3';
// Sound effects
import dingSrc from '../assets/effects/ding.mp3';
import rizzSrc from '../assets/effects/rizz-sound-effect.mp3';
import tacoBellSrc from '../assets/effects/taco-bell-bong-sfx.mp3';
import vineBoomSrc from '../assets/effects/vine-boom.mp3';
import '../styles/PackOpener.css';

const EFFECT_SOUNDS = [dingSrc, rizzSrc, tacoBellSrc, vineBoomSrc];

const PACK_SIZE = 5;
const TEAR_LINE_RATIO = 0.19;
const REQUIRED_CUT_RATIO = 0.72;
const MAX_CUT_POINTS = 64;
const MAX_SPARKS = 220;
const SPARK_LIFETIME_MS = 620;
const DRAWN_CUT_OFFSET_RATIO = 0.000;
const Motion = motion;

interface CutPoint {
    x: number;
    y: number;
}

interface Spark {
    id: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    size: number;
    hue: number;
}

interface CutSpan {
    minX: number;
    maxX: number;
}

interface PreloadedAssets {
    brainrotVoices: HTMLAudioElement[];
    cardFlip: HTMLAudioElement;
    effects: HTMLAudioElement[];
}

const EMPTY_CUT_SPAN: CutSpan = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
};

interface PackOpenerProps {
    onOpen: (cards: CardWithMeta[]) => void;
    cards: CardType[];
    disabled?: boolean;
}

const PackOpener = ({ onOpen, cards, disabled = false }: PackOpenerProps) => {
    const [isOpening, setIsOpening] = useState(false);
    const [openedCards, setOpenedCards] = useState<CardWithMeta[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPackCut, setIsPackCut] = useState(false);
    const [isCutting, setIsCutting] = useState(false);
    const [cutPoints, setCutPoints] = useState<CutPoint[]>([]);
    const [sparks, setSparks] = useState<Spark[]>([]);
    const [preloadedAssets, setPreloadedAssets] = useState<PreloadedAssets | null>(null);
    const [showSummary, setShowSummary] = useState(false);
    const [packDesign, setPackDesign] = useState(() => PACK_DESIGNS[Math.floor(Math.random() * PACK_DESIGNS.length)]);
    const [hasMovedMouse, setHasMovedMouse] = useState(false);
    const [selectedSummaryCard, setSelectedSummaryCard] = useState<CardWithMeta | null>(null);

    const packRef = useRef<HTMLDivElement>(null);
    const cutSpanRef = useRef<CutSpan>({ ...EMPTY_CUT_SPAN });
    const cutCompletedRef = useRef(false);
    const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isPointerDownRef = useRef(false);
    const sparkIdRef = useRef(0);
    const sparkTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const lastSparkAtRef = useRef(0);
    const fairyDustRef = useRef<HTMLAudioElement | null>(null);

    const clearSparks = useCallback(() => {
        sparkTimeoutsRef.current.forEach((timer) => window.clearTimeout(timer));
        sparkTimeoutsRef.current = [];
        setSparks([]);
    }, []);

    const emitSpark = useCallback((clientX: number, clientY: number) => {
        const now = Date.now();
        if (now - lastSparkAtRef.current < 9) return;
        lastSparkAtRef.current = now;

        const burstCount = 3;
        const newSparks: Spark[] = Array.from({ length: burstCount }, () => {
            const id = sparkIdRef.current++;
            return {
                id,
                x: clientX + (Math.random() * 16 - 8),
                y: clientY + (Math.random() * 4 - 2),
                dx: Math.random() * 56 - 28,
                dy: -(Math.random() * 36 + 10),
                size: Math.round(Math.random() * 8 + 9),
                hue: Math.round(Math.random() * 24 + 38),
            };
        });

        setSparks((prev) => {
            const next = [...prev, ...newSparks];
            return next.length > MAX_SPARKS ? next.slice(next.length - MAX_SPARKS) : next;
        });

        newSparks.forEach((spark) => {
            const timeout = window.setTimeout(() => {
                setSparks((prev) => prev.filter((item) => item.id !== spark.id));
                sparkTimeoutsRef.current = sparkTimeoutsRef.current.filter((item) => item !== timeout);
            }, SPARK_LIFETIME_MS);
            sparkTimeoutsRef.current.push(timeout);
        });
    }, []);

    const resetCutState = useCallback(() => {
        setIsCutting(false);
        setCutPoints([]);
        clearSparks();
        cutSpanRef.current = { ...EMPTY_CUT_SPAN };
        cutCompletedRef.current = false;
    }, [clearSparks]);

    const startOpening = useCallback(() => {
        // Generate 5 random cards for the pack with new 6-tier rarity system
        const pack: CardWithMeta[] = Array.from({ length: PACK_SIZE }, () => {
            const random = Math.random() * 100;
            let filtered: CardType[];
            // Rarity thresholds: BRAINROT 0.5%, LEGENDARY 2.5%, EPIC 7%, RARE 15%, UNCOMMON 25%, COMMON 50%
            if (random < 0.5) filtered = cards.filter(c => c.rarity === 'BRAINROT');
            else if (random < 3) filtered = cards.filter(c => c.rarity === 'LEGENDARY');
            else if (random < 10) filtered = cards.filter(c => c.rarity === 'EPIC');
            else if (random < 25) filtered = cards.filter(c => c.rarity === 'RARE');
            else if (random < 50) filtered = cards.filter(c => c.rarity === 'UNCOMMON');
            else filtered = cards.filter(c => c.rarity === 'COMMON');

            if (!filtered.length) filtered = cards;
            const card = filtered[Math.floor(Math.random() * filtered.length)];
            // 5% chance for holo
            const isHolo = Math.random() < 0.05;
            return { ...card, uniqueId: Math.random(), isRevealed: false, isHolo };
        });

        // Preload MP3 files
        const brainrotVoices = BRAINROT_VOICES.map(src => {
            const audio = new Audio(src);
            audio.preload = 'auto';
            audio.load();
            return audio;
        });

        const cardFlip = new Audio(cardFlipSrc);
        cardFlip.preload = 'auto';
        cardFlip.load();

        // Preload all effect sounds
        const effects = EFFECT_SOUNDS.map(src => {
            const audio = new Audio(src);
            audio.preload = 'auto';
            audio.load();
            return audio;
        });

        setPreloadedAssets({ brainrotVoices, cardFlip, effects });
        setOpenedCards(pack);
        setCurrentIndex(0);
        setIsOpening(true);
    }, [cards]);

    const finishPack = useCallback(() => {
        // Clean up preloaded audio assets
        if (preloadedAssets) {
            preloadedAssets.brainrotVoices.forEach(audio => { audio.src = ''; });
            preloadedAssets.cardFlip.src = '';
            preloadedAssets.effects.forEach(audio => { audio.src = ''; });
        }
        setPreloadedAssets(null);
        setIsOpening(false);
        setOpenedCards([]);
        setCurrentIndex(0);
        setIsPackCut(false);
        setShowSummary(false);
        setHasMovedMouse(false);
        setPackDesign(PACK_DESIGNS[Math.floor(Math.random() * PACK_DESIGNS.length)]);
        resetCutState();
    }, [resetCutState, preloadedAssets]);

    const nextCard = useCallback(() => {
        if (currentIndex < openedCards.length - 1) {
            setCurrentIndex(currentIndex + 1);
        } else {
            // Add cards to collection and show summary
            onOpen(openedCards);
            setShowSummary(true);
        }
    }, [currentIndex, openedCards, onOpen]);

    const closeSummary = useCallback(() => {
        finishPack();
    }, [finishPack]);

    // Helper to play and cleanup audio
    const playAndCleanup = useCallback((audio: HTMLAudioElement) => {
        const clone = audio.cloneNode() as HTMLAudioElement;
        clone.onended = () => { clone.src = ''; };
        clone.play().catch(() => {});
        return clone;
    }, []);

    // Play "what kind of brainrot" when a new card appears (after card animation finishes)
    useEffect(() => {
        if (isOpening && preloadedAssets && openedCards[currentIndex] && !openedCards[currentIndex].isRevealed) {
            const timer = setTimeout(() => {
                const randomVoice = preloadedAssets.brainrotVoices[Math.floor(Math.random() * preloadedAssets.brainrotVoices.length)];
                playAndCleanup(randomVoice);
            }, 700);
            return () => clearTimeout(timer);
        }
    }, [isOpening, currentIndex, preloadedAssets, openedCards, playAndCleanup]);

    // Hide mouse hint after user moves mouse
    useEffect(() => {
        if (!isOpening || hasMovedMouse) return;
        const handleMouseMove = () => setHasMovedMouse(true);
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [isOpening, hasMovedMouse]);

    const handleFlip = useCallback(() => {
        const currentCard = openedCards[currentIndex];
        if (!currentCard || !preloadedAssets) return;

        // Play card flip sound
        playAndCleanup(preloadedAssets.cardFlip);

        // Pick a random effect sound and play
        const randomEffect = preloadedAssets.effects[Math.floor(Math.random() * preloadedAssets.effects.length)];
        playAndCleanup(randomEffect);

        const newCards = [...openedCards];
        newCards[currentIndex].isRevealed = true;
        setOpenedCards(newCards);

        if (currentCard.rarity === 'BRAINROT' || currentCard.rarity === 'LEGENDARY' || currentCard.rarity === 'EPIC') {
            const colors = currentCard.rarity === 'BRAINROT'
                ? ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#0000ff', '#9400d3']
                : currentCard.rarity === 'LEGENDARY'
                    ? ['#ff8000', '#ffd700']
                    : ['#a335ee', '#bc13fe'];
            confetti({
                particleCount: currentCard.rarity === 'BRAINROT' ? 250 : 150,
                spread: currentCard.rarity === 'BRAINROT' ? 100 : 70,
                origin: { y: 0.6 },
                colors
            });
        }

        // Sparkles for holo cards
        if (currentCard.isHolo) {
            // Burst of star-shaped sparkles
            confetti({
                particleCount: 60,
                spread: 80,
                origin: { y: 0.55 },
                colors: ['#ffffff', '#fffacd', '#f0f8ff', '#e6e6fa', '#ffd700'],
                shapes: ['star'],
                scalar: 1.2,
                gravity: 0.8,
                drift: 0,
                ticks: 150
            });
            // Second burst slightly delayed for more sparkle effect
            setTimeout(() => {
                confetti({
                    particleCount: 40,
                    spread: 60,
                    origin: { y: 0.5, x: 0.4 },
                    colors: ['#ffffff', '#fffacd', '#87ceeb', '#dda0dd'],
                    shapes: ['star'],
                    scalar: 0.9,
                    gravity: 0.6,
                    ticks: 120
                });
                confetti({
                    particleCount: 40,
                    spread: 60,
                    origin: { y: 0.5, x: 0.6 },
                    colors: ['#ffffff', '#fffacd', '#87ceeb', '#dda0dd'],
                    shapes: ['star'],
                    scalar: 0.9,
                    gravity: 0.6,
                    ticks: 120
                });
            }, 150);
        }
    }, [openedCards, currentIndex, preloadedAssets, playAndCleanup]);

    const getLocalPoint = useCallback((clientX: number, clientY: number) => {
        const rect = packRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            tearY: rect.height * TEAR_LINE_RATIO,
            tolerance: Math.min(52, Math.max(26, rect.height * 0.08)),
        };
    }, []);

    const completeCut = useCallback(() => {
        if (cutCompletedRef.current) return;

        cutCompletedRef.current = true;
        setIsCutting(false);
        setIsPackCut(true);
        setCutPoints([]);
        clearSparks();

        // Play woosh sound
        const woosh = new Audio(wooshSrc);
        woosh.onended = () => { woosh.src = ''; };
        woosh.play().catch(() => {});

        if (openTimeoutRef.current) {
            window.clearTimeout(openTimeoutRef.current);
        }

        openTimeoutRef.current = window.setTimeout(() => {
            startOpening();
        }, 460);
    }, [startOpening, clearSparks]);

    const beginOrContinueCut = useCallback((clientX: number, clientY: number) => {
        if (cutCompletedRef.current || isOpening || isPackCut) return;

        const point = getLocalPoint(clientX, clientY);
        if (!point) return;

        const nearTearLine = Math.abs(point.y - point.tearY) <= point.tolerance;
        if (!nearTearLine) {
            return;
        }

        const clampedX = Math.min(point.width, Math.max(0, point.x));
        const xPercent = (clampedX / point.width) * 100;
        const yPercent = (TEAR_LINE_RATIO + DRAWN_CUT_OFFSET_RATIO) * 100;
        const sparkY = point.top + (point.height * yPercent) / 100;

        if (!isCutting) {
            setIsCutting(true);
            setCutPoints([{ x: xPercent, y: yPercent }]);
            cutSpanRef.current = { minX: clampedX, maxX: clampedX };
            emitSpark(clientX, sparkY);

            // Play fairy dust sound when cutting starts
            if (fairyDustRef.current) {
                fairyDustRef.current.pause();
                fairyDustRef.current.currentTime = 0;
            }
            fairyDustRef.current = new Audio(fairyDustSrc);
            fairyDustRef.current.play().catch(() => {});
            return;
        }

        setCutPoints((prev) => {
            const next = [...prev, { x: xPercent, y: yPercent }];
            return next.length > MAX_CUT_POINTS ? next.slice(next.length - MAX_CUT_POINTS) : next;
        });
        emitSpark(clientX, sparkY);

        const span = cutSpanRef.current;
        span.minX = Math.min(span.minX, clampedX);
        span.maxX = Math.max(span.maxX, clampedX);
        cutSpanRef.current = span;

        const coveredDistance = Math.max(0, span.maxX - span.minX);

        const touchedLeft = span.minX <= point.width * 0.18;
        const touchedRight = span.maxX >= point.width * 0.82;

        if (touchedLeft && touchedRight && coveredDistance >= point.width * REQUIRED_CUT_RATIO) {
            completeCut();
        }
    }, [isCutting, isOpening, isPackCut, getLocalPoint, emitSpark, completeCut]);

    const endCutAttempt = useCallback(() => {
        setIsCutting(false);
        isPointerDownRef.current = false;
        clearSparks();

        // Stop fairy dust sound
        if (fairyDustRef.current) {
            fairyDustRef.current.pause();
            fairyDustRef.current = null;
        }

        if (!cutCompletedRef.current) {
            setCutPoints([]);
            cutSpanRef.current = { ...EMPTY_CUT_SPAN };
        }
    }, [clearSparks]);

    const handleInteraction = useCallback(() => {
        if (!isOpening) return;

        const currentItem = openedCards[currentIndex];
        if (currentItem && !currentItem.isRevealed) {
            handleFlip();
        } else {
            nextCard();
        }
    }, [isOpening, openedCards, currentIndex, handleFlip, nextCard]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if disabled, showing summary, not opening, or key is held down
            if (disabled || showSummary || !isOpening || e.repeat) return;

            if (e.code === 'Space') {
                e.preventDefault();
                handleInteraction();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpening, handleInteraction, disabled, showSummary]);

    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            isPointerDownRef.current = true;
            beginOrContinueCut(event.clientX, event.clientY);
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (cutCompletedRef.current || isOpening || isPackCut) return;
            const isPressed = isPointerDownRef.current || event.buttons === 1 || event.pressure > 0;
            if (!isPressed) return;
            beginOrContinueCut(event.clientX, event.clientY);
        };

        const handlePointerEnd = () => {
            if (!isPointerDownRef.current && !isCutting) return;
            endCutAttempt();
        };

        const handleBlur = () => {
            endCutAttempt();
        };

        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerEnd);
        window.addEventListener('pointercancel', handlePointerEnd);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerEnd);
            window.removeEventListener('pointercancel', handlePointerEnd);
            window.removeEventListener('blur', handleBlur);
        };
    }, [isCutting, isOpening, isPackCut, beginOrContinueCut, endCutAttempt]);

    useEffect(() => () => {
        if (openTimeoutRef.current) {
            window.clearTimeout(openTimeoutRef.current);
        }
        if (fairyDustRef.current) {
            fairyDustRef.current.pause();
            fairyDustRef.current.src = '';
            fairyDustRef.current = null;
        }
        clearSparks();
    }, [clearSparks]);

    const currentCard = openedCards[currentIndex];

    return (
        <div className="pack-opener-container">
            <AnimatePresence mode="wait">
                {!isOpening ? (
                    <Motion.div
                        key="pack"
                        initial={{ y: '-100vh', opacity: 0, rotate: -10 }}
                        animate={{ y: 0, opacity: 1, rotate: 0 }}
                        exit={{ scale: 1.5, opacity: 0 }}
                        transition={{
                            type: 'spring',
                            stiffness: 80,
                            damping: 12,
                            mass: 1
                        }}
                        className="pack-display"
                    >
                        <div className="pack-shell-wrap">
                            <div
                                ref={packRef}
                                className={`pack-shell ${isCutting ? 'is-cutting' : ''} ${isPackCut ? 'is-cut' : ''}`}
                            >
                                <img
                                    className="pack-half pack-half-bottom"
                                    src={packDesign}
                                    alt="Brainrot TCG booster pack wrapper"
                                    draggable="false"
                                />
                                <img
                                    className="pack-half pack-half-top"
                                    src={packDesign}
                                    alt=""
                                    aria-hidden="true"
                                    draggable="false"
                                />
                                <div className="tear-guide" />
                                <div className="swipe-hint">
                                    <span className="swipe-hint-icon">👆</span>
                                    <span className="swipe-hint-text">Swipe to open</span>
                                </div>
                                {cutPoints.length > 1 && (
                                    <svg className="cut-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                                        <polyline
                                            className="cut-line"
                                            points={cutPoints.map(p => `${p.x},${p.y}`).join(' ')}
                                        />
                                    </svg>
                                )}
                            </div>
                            <p className="pack-hint">nothing to see here!</p>
                        </div>
                    </Motion.div>
                ) : (
                    <Motion.div
                        key="opening"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="card-reveal-area"
                    >
                        {!showSummary ? (
                            <>
                                <div className="reveal-counter">
                                    {currentIndex + 1} / {openedCards.length}
                                </div>

                                <AnimatePresence mode="wait">
                                    {currentCard && (
                                        <Motion.div
                                            key={currentCard.uniqueId}
                                            initial={{ x: 500, opacity: 0, rotate: 10 }}
                                            animate={{ x: 0, opacity: 1, rotate: 0 }}
                                            exit={{ x: -500, opacity: 0, rotate: -10 }}
                                            className="active-card-container"
                                        >
                                            <Card
                                                card={currentCard}
                                                isFlipped={currentCard.isRevealed}
                                                onFlip={handleInteraction}
                                            />
                                        </Motion.div>
                                    )}
                                </AnimatePresence>

                                <div className="tip-text">
                                    {currentCard?.isRevealed ? "Click or Space to see next" : "Click or Space to reveal"}
                                </div>
                                <div className={`mouse-hint ${hasMovedMouse ? 'fade-out' : ''}`}>Move mouse around card to tilt</div>
                            </>
                        ) : (
                            <Motion.div
                                className="pack-summary"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                            >
                                <h2 className="summary-title">Pack Summary</h2>
                                <div className="summary-carousel">
                                    {openedCards.map((card, index) => {
                                        const totalCards = openedCards.length;
                                        const offset = (index - (totalCards - 1) / 2);
                                        const classes = [
                                            'summary-card',
                                            card.rarity.toLowerCase(),
                                            card.isHolo ? 'holo' : ''
                                        ].filter(Boolean).join(' ');
                                        return (
                                            <div
                                                key={card.uniqueId}
                                                className={classes}
                                                style={{ '--offset': offset } as React.CSSProperties}
                                                onClick={() => setSelectedSummaryCard(card)}
                                            >
                                                <img src={card.image} alt={card.name} />
                                            </div>
                                        );
                                    })}
                                </div>
                                <button className="summary-close-btn" onClick={closeSummary}>
                                    Open Another Pack
                                </button>

                                {/* Card Viewer Modal for summary */}
                                {selectedSummaryCard && (
                                    <CardViewerModal
                                        card={selectedSummaryCard}
                                        isHolo={selectedSummaryCard.isHolo}
                                        onClose={() => setSelectedSummaryCard(null)}
                                    />
                                )}
                            </Motion.div>
                        )}
                    </Motion.div>
                )}
            </AnimatePresence>
            <div className="spark-layer" aria-hidden="true">
                {sparks.map((spark) => (
                    <span
                        key={spark.id}
                        className="drag-spark"
                        style={{
                            '--x': `${spark.x}px`,
                            '--y': `${spark.y}px`,
                            '--dx': `${spark.dx}px`,
                            '--dy': `${spark.dy}px`,
                            '--size': `${spark.size}px`,
                            '--hue': spark.hue,
                        } as React.CSSProperties}
                    />
                ))}
            </div>
        </div>
    );
};

export default PackOpener;
