import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import Card from './Card';
import packDesign from '../assets/pack1.png';
import '../styles/PackOpener.css';

const PACK_SIZE = 5;
const TEAR_LINE_RATIO = 0.19;
const REQUIRED_CUT_RATIO = 0.72;
const MAX_CUT_POINTS = 64;
const MAX_SPARKS = 220;
const SPARK_LIFETIME_MS = 620;
const DRAWN_CUT_OFFSET_RATIO = 0.008;
const Motion = motion;

const EMPTY_CUT_SPAN = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
};

const PackOpener = ({ onOpen, cards }) => {
    const [isOpening, setIsOpening] = useState(false);
    const [openedCards, setOpenedCards] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPackCut, setIsPackCut] = useState(false);
    const [isCutting, setIsCutting] = useState(false);
    const [cutPoints, setCutPoints] = useState([]);
    const [sparks, setSparks] = useState([]);

    const packRef = useRef(null);
    const cutSpanRef = useRef({ ...EMPTY_CUT_SPAN });
    const cutCompletedRef = useRef(false);
    const openTimeoutRef = useRef(null);
    const isPointerDownRef = useRef(false);
    const sparkIdRef = useRef(0);
    const sparkTimeoutsRef = useRef([]);
    const lastSparkAtRef = useRef(0);

    const clearSparks = useCallback(() => {
        sparkTimeoutsRef.current.forEach((timer) => window.clearTimeout(timer));
        sparkTimeoutsRef.current = [];
        setSparks([]);
    }, []);

    const emitSpark = useCallback((clientX, clientY) => {
        const now = Date.now();
        if (now - lastSparkAtRef.current < 9) return;
        lastSparkAtRef.current = now;

        const burstCount = 3;
        const newSparks = Array.from({ length: burstCount }, () => {
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
        setIsOpening(true);
        const pack = Array.from({ length: PACK_SIZE }, () => {
            const random = Math.random() * 100;
            let filtered;
            if (random < 2) filtered = cards.filter(c => c.rarity === 'LEGENDARY');
            else if (random < 10) filtered = cards.filter(c => c.rarity === 'EPIC');
            else if (random < 30) filtered = cards.filter(c => c.rarity === 'RARE');
            else filtered = cards.filter(c => c.rarity === 'COMMON');

            if (!filtered.length) filtered = cards;
            return { ...filtered[Math.floor(Math.random() * filtered.length)], uniqueId: Math.random(), isRevealed: false };
        });
        setOpenedCards(pack);
        setCurrentIndex(0);
    }, [cards]);

    const finishPack = useCallback(() => {
        setIsOpening(false);
        setOpenedCards([]);
        setCurrentIndex(0);
        setIsPackCut(false);
        resetCutState();
    }, [resetCutState]);

    const nextCard = useCallback(() => {
        if (currentIndex < openedCards.length - 1) {
            setCurrentIndex(currentIndex + 1);
        } else {
            onOpen(openedCards);
            finishPack();
        }
    }, [currentIndex, openedCards, onOpen, finishPack]);

    const handleFlip = useCallback(() => {
        const currentCard = openedCards[currentIndex];
        if (!currentCard) return;

        const audio = new Audio('/sounds/ding.mp3');
        audio.play().catch(e => console.log("Audio playback failed:", e));

        const newCards = [...openedCards];
        newCards[currentIndex].isRevealed = true;
        setOpenedCards(newCards);

        if (currentCard.rarity === 'LEGENDARY' || currentCard.rarity === 'EPIC') {
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: currentCard.rarity === 'LEGENDARY' ? ['#ff8000', '#ffd700'] : ['#a335ee', '#bc13fe']
            });
        }
    }, [openedCards, currentIndex]);

    const getLocalPoint = useCallback((clientX, clientY) => {
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

        if (openTimeoutRef.current) {
            window.clearTimeout(openTimeoutRef.current);
        }

        openTimeoutRef.current = window.setTimeout(() => {
            startOpening();
        }, 460);
    }, [startOpening, clearSparks]);

    const beginOrContinueCut = useCallback((clientX, clientY) => {
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
        const handleKeyDown = (e) => {
            if (e.code === 'Space' && isOpening) {
                e.preventDefault();
                handleInteraction();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpening, handleInteraction]);

    useEffect(() => {
        const handlePointerDown = (event) => {
            if (event.button !== 0) return;
            isPointerDownRef.current = true;
            beginOrContinueCut(event.clientX, event.clientY);
        };

        const handlePointerMove = (event) => {
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
        clearSparks();
    }, [clearSparks]);

    const currentCard = openedCards[currentIndex];

    return (
        <div className="pack-opener-container">
            <AnimatePresence mode="wait">
                {!isOpening ? (
                    <Motion.div
                        key="pack"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 1.5, opacity: 0 }}
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
                            </div>
                        </div>
                    </Motion.div>
                ) : (
                    <Motion.div
                        key="opening"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="card-reveal-area"
                    >
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
                        }}
                    />
                ))}
            </div>
        </div>
    );
};

export default PackOpener;
