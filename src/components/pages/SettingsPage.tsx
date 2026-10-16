import { useEffect, useId, useRef, useState } from 'react';
import { Download, History, Upload } from 'lucide-react';
import { STORAGE_KEYS } from '../../constants';
import { canBringOldSave, fetchOldSave, FULL_MOVE_NOTE, hasProgress, importSave, PARTIAL_MOVE_NOTE, type MoveResult } from '../../game/move';
import { reloadPage } from '../../game/reload';
import { CARD_FLIP_SRC, EFFECT_DELAY_MS, VINE_BOOM_SRC, soundVolume } from '../../constants/audio';
import { effectsLevel } from '../../utils/settings';
import { SPECIAL_REVEAL_CUTOFF, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import type { Settings } from '../../types';
import type { SetDefinition } from '../../engine';
import CardGuideButton from '../ui/CardGuideButton';
import DiagnosticReport from '../ui/DiagnosticReport';
import KeptAsideActions from '../ui/KeptAsideActions';
import '../../styles/Settings.css';
import { downloadSaveFile, NO_ROOM_FOR_COPY_NOTE } from '../../game/saveFile';

interface SettingsPageProps {
    settings: Settings;
    onSettingsChange: (settings: Settings) => void;
    /** Returns an error to show, or null (the page then reloads with the imported save). keepCopy false skips the copy of the current save. */
    onImportSave: (data: string, keepCopy?: boolean) => string | null;
    saveWarning?: string;
    /** Shown beside the warning when only a reload fixes it (the save changed in another tab). */
    onReload?: () => void;
    /** Unreadable collection data kept aside (its note): shown first in Save & backup, with Download and Discard. */
    recoveryNote?: string;
    /** Whether this tab may still download or discard it (false once the save changed in another tab). */
    recoveryAllowed?: () => boolean;
    /** What's kept aside changed (discarded here, or more kept aside meanwhile); the app refreshes what it shows. */
    onRecoveryChanged?: () => void;
    /** The pack being opened: Help's card guide shows its odds. */
    guideSet?: SetDefinition;
}

/** The Settings page (#/settings): Sound & display, Save & backup (the 'save' link scrolls to it) and Help (card guide, report a problem). */
const SettingsPage = ({ settings, onSettingsChange, onImportSave, saveWarning, onReload, recoveryNote, recoveryAllowed, onRecoveryChanged, guideSet }: SettingsPageProps) => {
    const [reporting, setReporting] = useState(false);
    const saveHeadingRef = useRef<HTMLHeadingElement>(null);
    const reloadRef = useRef<HTMLButtonElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const handleExportSave = () => downloadSaveFile();

    // After the site moved: fetch the save from the old address (game/move.ts). Replacing a different
    // save here is asked in this row, not in a browser dialog, which can open behind the old address's
    // window.
    const [oldSaveNote, setOldSaveNote] = useState('Played at the old address? Bring that save here.');
    const [oldSave, setOldSave] = useState<{ save: unknown } | null>(null);
    const keepRef = useRef<HTMLButtonElement>(null);
    // Leaving the page drops a preview still waiting to play.
    useEffect(() => () => clearTimeout(samplePending), []);
    useEffect(() => {
        if (oldSave) keepRef.current?.focus();
    }, [oldSave]);
    const showBringResult = (result: MoveResult) => {
        setOldSave(null);
        if (result === 'saved') return window.location.reload();
        if (result === 'partial') {
            // This page still shows the save from before; only a reload shows what storage now holds.
            window.alert(PARTIAL_MOVE_NOTE);
            return reloadPage();
        }
        setOldSaveNote(
            result === 'same' ? 'Your save from the old address is already here.'
            : result === 'kept' ? 'Kept the save you have here.'
            : result === 'full' ? FULL_MOVE_NOTE
            : "Couldn't bring that save over, so nothing changed.",
        );
    };
    const handleBringOldSave = async () => {
        setOldSaveNote('Opening the old address…');
        const got = await fetchOldSave();
        if (got === 'blocked') return setOldSaveNote('Your browser blocked the window. Allow pop-ups for this site, then try again.');
        if (got === 'none') return setOldSaveNote('There was no save at the old address.');
        if (got === 'timeout') return setOldSaveNote("The old address didn't answer, so nothing changed. Try again.");
        // Don't replace a different save yet: ask first.
        const result = importSave(got.save, () => false);
        if (result !== 'kept') return showBringResult(result);
        setOldSave(got);
        setOldSaveNote('This browser has a different save. Replace it with the old one? The one here is kept as a backup.');
    };

    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    /** A backup file waiting for "Replace", and what to say about it. */
    const [pendingImport, setPendingImport] = useState<string | null>(null);
    const [importNote, setImportNote] = useState('Load a backup file');
    /** Storage has no room for the file and a copy of the current save, so "Replace" would go ahead without the copy. */
    const [withoutCopy, setWithoutCopy] = useState(false);
    /** "this browser's save (X) with the file's (Y)" while the player is asked to replace a save. */
    const [replacing, setReplacing] = useState<string | null>(null);

    /** "Name, 14 packs" for a save's player and stats (as stored, or as in a backup file). */
    const describe = (player: string | null | undefined, stats: string | null | undefined) => {
        try {
            const name = (JSON.parse(player ?? 'null') as { name?: string } | null)?.name;
            const packs = (JSON.parse(stats ?? 'null') as { packsOpened?: number } | null)?.packsOpened ?? 0;
            return `${name ? `${name}, ` : ''}${packs.toLocaleString()} pack${packs === 1 ? '' : 's'}`;
        } catch {
            return 'unknown';
        }
    };

    const runImport = (content: string, keepCopy = true) => {
        setPendingImport(null);
        setWithoutCopy(false);
        const error = onImportSave(content, keepCopy);
        if (!error) return;
        // Nothing changed; the player may export first, then choose to replace without the copy.
        if (keepCopy && error === NO_ROOM_FOR_COPY_NOTE) {
            setImportNote(replacing ? `${error} Replace ${replacing} without keeping a copy?` : error);
            setPendingImport(content);
            setWithoutCopy(true);
        } else setImportNote(error);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const content = event.target?.result as string;
            let incoming: { player?: string; stats?: string } = {};
            try {
                incoming = JSON.parse(content);
            } catch {
                return setImportNote("Couldn't read that file. Is it a save exported from Save & backup?");
            }
            // Replacing real progress with someone else's (or an older) save asks first, in the page.
            const here = localStorage.getItem('brainrot-player-v1');
            const sameKey = (() => {
                try {
                    return !!incoming.player && JSON.parse(here ?? '{}').secretKey === JSON.parse(incoming.player).secretKey;
                } catch {
                    return false;
                }
            })();
            if (!hasProgress() || (sameKey && describe(here, localStorage.getItem(STORAGE_KEYS.STATS)) === describe(incoming.player, incoming.stats))) {
                setReplacing(null);
                return runImport(content);
            }
            const saves = `this browser's save (${describe(here, localStorage.getItem(STORAGE_KEYS.STATS))}) with the file's (${describe(incoming.player, incoming.stats)})`;
            setReplacing(saves);
            setPendingImport(content);
            setImportNote(`Replace ${saves}? Yours is kept as a backup.`);
        };
        reader.readAsText(file);

        // Reset input so the same file can be selected again
        e.target.value = '';
    };

    return (
        <div className="settings">
            {saveWarning && (
                <p role="alert" className="save-warning">
                    {saveWarning}
                    {onReload && <button type="button" ref={reloadRef} className="link-btn save-warning-action quiet-focus" onClick={onReload}>Reload</button>}
                </p>
            )}
            <section className="settings-group" aria-labelledby="settings-sound">
                <h2 id="settings-sound" className="section-title">Sound &amp; display</h2>
                <div className="settings-panel">
                    <SliderRow
                        label="Music"
                        desc="Background music"
                        value={settings.musicVolume}
                        onChange={(musicVolume) => onSettingsChange({ ...settings, musicVolume })}
                    />
                    <SliderRow
                        label="Sound effects"
                        desc="Cards, the pack and voices"
                        value={settings.effectsVolume}
                        onChange={(effectsVolume) => onSettingsChange({ ...settings, effectsVolume })}
                        onRelease={(effectsVolume) => playSample(effectsVolume)}
                    />
                    <SwitchRow
                        label="Particles"
                        desc="Sparks and confetti"
                        checked={settings.particlesEnabled}
                        onChange={() => onSettingsChange({ ...settings, particlesEnabled: !settings.particlesEnabled })}
                    />
                    <SwitchRow
                        label="Pause on good pulls"
                        desc={`Hold cards worth ${SPECIAL_REVEAL_CUTOFF.toLocaleString()}+ points for ${SPECIAL_REVEAL_DURATION_MS / 1000} seconds. Off: reveal effects still play, but you can skip.`}
                        checked={settings.pauseBigPulls !== false}
                        onChange={() => onSettingsChange({ ...settings, pauseBigPulls: settings.pauseBigPulls === false })}
                    />
                    <SwitchRow
                        label="Preview upcoming sets"
                        desc="Sets still waiting for their final art"
                        checked={!!settings.showDraftSets}
                        onChange={() => onSettingsChange({ ...settings, showDraftSets: !settings.showDraftSets })}
                    />
                </div>
            </section>

            <section id="save-backup" className="settings-group" aria-labelledby="settings-save">
                <h2 id="settings-save" ref={saveHeadingRef} className="section-title" tabIndex={-1}>Save &amp; backup</h2>
                <div className="settings-panel">
                    {recoveryNote && recoveryAllowed && (
                        <div className="settings-row settings-row--wrap">
                            <span className="settings-text">
                                <span className="settings-label">Kept-aside data</span>
                                <span className="settings-desc">{recoveryNote}</span>
                            </span>
                            <KeptAsideActions variant="settings" canAct={recoveryAllowed} onGone={() => {
                                onRecoveryChanged?.();
                                // The row leaves with its buttons: focus stays in this section.
                                saveHeadingRef.current?.focus();
                            }} onChanged={() => onRecoveryChanged?.()} onLeave={() => {
                                (reloadRef.current ?? saveHeadingRef.current)?.focus();
                            }} />
                        </div>
                    )}
                    <div className="settings-row">
                        <span className="settings-text">
                            <span className="settings-label">Back up</span>
                            <span className="settings-desc">Includes your secret player key. Keep the file private.</span>
                        </span>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={handleExportSave}>
                            <Download aria-hidden="true" /> Export
                        </button>
                    </div>
                    <div className={pendingImport ? 'settings-row settings-row--wrap' : 'settings-row'}>
                        <span className="settings-text">
                            <span className="settings-label">Restore</span>
                            <span className="settings-desc" role="status">{importNote}</span>
                        </span>
                        {pendingImport ? (
                            <span className="settings-actions">
                                <button
                                    type="button"
                                    className="btn btn--secondary btn--sm"
                                    onClick={() => {
                                        setPendingImport(null);
                                        setWithoutCopy(false);
                                        setImportNote('Kept your save.');
                                    }}
                                >
                                    Keep mine
                                </button>
                                <button type="button" className="btn btn--primary btn--sm" onClick={() => runImport(pendingImport, !withoutCopy)}>
                                    {withoutCopy ? 'Replace without a copy' : 'Replace'}
                                </button>
                            </span>
                        ) : (
                            <button type="button" className="btn btn--secondary btn--sm" onClick={handleImportClick}>
                                <Upload aria-hidden="true" /> Import
                            </button>
                        )}
                        <input ref={fileInputRef} type="file" accept=".txt,.json" onChange={handleFileChange} hidden />
                    </div>
                    {canBringOldSave() && (
                        <div className={oldSave ? 'settings-row settings-row--wrap' : 'settings-row'}>
                            <span className="settings-text">
                                <span className="settings-label">From the old address</span>
                                <span className="settings-desc" role="status">{oldSaveNote}</span>
                            </span>
                            {oldSave ? (
                                <span className="settings-actions">
                                    <button type="button" ref={keepRef} className="btn btn--secondary btn--sm quiet-focus" onClick={() => showBringResult('kept')}>
                                        Keep mine
                                    </button>
                                    <button type="button" className="btn btn--primary btn--sm" onClick={() => showBringResult(importSave(oldSave.save, () => true))}>
                                        Replace
                                    </button>
                                </span>
                            ) : (
                                <button type="button" className="btn btn--secondary btn--sm" onClick={handleBringOldSave}>
                                    <History aria-hidden="true" /> Bring it
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </section>
            <section className="settings-group" aria-labelledby="settings-help">
                <h2 id="settings-help" className="section-title">Help</h2>
                <div className="settings-help-actions">
                    {guideSet && <CardGuideButton set={guideSet} className="btn btn--secondary" />}
                    <button type="button" className="btn btn--secondary" onClick={() => setReporting(true)}>Report a problem</button>
                </div>
            </section>
            {reporting && <DiagnosticReport onClose={() => setReporting(false)} />}
        </div>
    );
};

let samplePending: ReturnType<typeof setTimeout> | undefined;

/** A reveal at the effects volume just chosen (the flip, then a vine boom), so you hear what you picked. */
const playSample = (value: number) => {
    clearTimeout(samplePending);
    if (value === 0) return;
    const level = effectsLevel(value);
    const play = (src: string) => {
        const sample = new Audio(src);
        sample.volume = soundVolume(src, level);
        sample.play().catch(() => {});
    };
    play(CARD_FLIP_SRC);
    samplePending = setTimeout(() => play(VINE_BOOM_SRC), EFFECT_DELAY_MS);
};

/** A volume slider in steps of 5%; all the way left is off. */
const SliderRow = ({ label, desc, value, onChange, onRelease }: { label: string; desc: string; value: number; onChange: (value: number) => void; onRelease?: (value: number) => void }) => {
    const id = useId();
    const percent = Math.round(value * 100);
    const text = percent === 0 ? 'Off' : `${percent}%`;
    const release = (e: React.SyntheticEvent<HTMLInputElement>) => onRelease?.(Number(e.currentTarget.value) / 100);
    return (
        <div className="settings-row">
            <span className="settings-text">
                <label className="settings-label" htmlFor={id}>{label}</label>
                <span className="settings-desc" id={`${id}-desc`}>{desc}</span>
            </span>
            <span className="settings-slider">
                <input
                    id={id}
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={percent}
                    aria-describedby={`${id}-desc`}
                    aria-valuetext={text}
                    onChange={(e) => onChange(Number(e.target.value) / 100)}
                    onPointerUp={release}
                    onKeyUp={release}
                />
                <span className="settings-value tabular" aria-hidden="true">{text}</span>
            </span>
        </div>
    );
};

const SwitchRow = ({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: () => void }) => {
    const id = useId();
    return (
        <div className="settings-row">
            <span className="settings-text">
                <span className="settings-label" id={`${id}-label`}>{label}</span>
                <span className="settings-desc" id={`${id}-desc`}>{desc}</span>
            </span>
            <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={checked}
                aria-labelledby={`${id}-label`}
                aria-describedby={`${id}-desc`}
                onClick={onChange}
            />
        </div>
    );
};

export default SettingsPage;
