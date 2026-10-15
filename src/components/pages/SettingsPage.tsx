import { useEffect, useId, useRef, useState } from 'react';
import { Download, History, Upload } from 'lucide-react';
import { STORAGE_KEYS } from '../../constants';
import { MAX_NAME_LENGTH } from '../../engine';
import { exportPlayer, getPlayer, renamePlayer } from '../../game/player';
import { canBringOldSave, fetchOldSave, hasProgress, importSave, type MoveResult } from '../../game/move';
import { CARD_FLIP_SRC } from '../../constants/audio';
import { effectsLevel } from '../../utils/settings';
import { SPECIAL_REVEAL_CUTOFF, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import type { Settings } from '../../types';
import Sheet from '../ui/Sheet';
import '../../styles/Settings.css';
import { CURRENT_DATA_VERSION } from '../../utils/migrations';

interface SettingsPageProps {
    settings: Settings;
    onSettingsChange: (settings: Settings) => void;
    onClose: () => void;
    /** Returns an error to show, or null (the page then reloads with the imported save). */
    onImportSave: (data: string) => string | null;
    saveWarning?: string;
}

const SettingsPage = ({ settings, onSettingsChange, onClose, onImportSave, saveWarning }: SettingsPageProps) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [player, setPlayer] = useState(getPlayer);
    const [nameDraft, setNameDraft] = useState(player.name);

    const saveName = () => {
        const updated = renamePlayer(nameDraft);
        setPlayer(updated);
        setNameDraft(updated.name);
    };

    const handleExportSave = () => {
        const saveData = {
            collection: localStorage.getItem(STORAGE_KEYS.COLLECTION),
            achievements: localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS),
            stats: localStorage.getItem(STORAGE_KEYS.STATS),
            hallOfFame: localStorage.getItem(STORAGE_KEYS.HALL_OF_FAME),
            settings: localStorage.getItem(STORAGE_KEYS.SETTINGS),
            history: localStorage.getItem(STORAGE_KEYS.HISTORY),
            // Your secret player key: it's what makes your pulls yours. Don't share this file.
            player: exportPlayer(),
            exportedAt: new Date().toISOString(),
            version: 2,
            // Shape of the stored data, so importing an older save runs the migrations it needs.
            dataVersion: CURRENT_DATA_VERSION,
        };

        const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `brainrot-tcg-save-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // After the site moved: fetch the save from the old address (game/move.ts). Replacing a different
    // save here is asked in this row, not in a browser dialog, which can open behind the old address's
    // window.
    const [oldSaveNote, setOldSaveNote] = useState('Played at the old address? Bring that save here.');
    const [oldSave, setOldSave] = useState<{ save: unknown } | null>(null);
    const keepRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (oldSave) keepRef.current?.focus();
    }, [oldSave]);
    const showBringResult = (result: MoveResult) => {
        setOldSave(null);
        if (result === 'saved') return window.location.reload();
        setOldSaveNote(
            result === 'same' ? 'Your save from the old address is already here.'
            : result === 'kept' ? 'Kept the save you have here.'
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

    const runImport = (content: string) => {
        setPendingImport(null);
        const error = onImportSave(content);
        if (error) setImportNote(error);
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
                return setImportNote("Couldn't read that file. Is it a save exported from Settings?");
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
                return runImport(content);
            }
            setPendingImport(content);
            setImportNote(
                `Replace this browser's save (${describe(here, localStorage.getItem(STORAGE_KEYS.STATS))}) with the file's (${describe(incoming.player, incoming.stats)})? Yours is kept as a backup.`,
            );
        };
        reader.readAsText(file);

        // Reset input so the same file can be selected again
        e.target.value = '';
    };

    return (
        <Sheet title="Settings" onClose={onClose} size="sm" className="settings">
            {saveWarning && <p role="alert" className="save-warning">{saveWarning}</p>}
            <section className="settings-group">
                <h3 className="section-title" id="settings-player">Player</h3>
                <div className="settings-panel">
                    <label className="settings-field">
                        <span className="settings-label">Name</span>
                        <input
                            className="settings-input"
                            value={nameDraft}
                            onChange={(e) => setNameDraft(Array.from(e.target.value).slice(0, MAX_NAME_LENGTH).join(''))}
                            onBlur={saveName}
                            onKeyDown={(e) => e.key === 'Enter' && saveName()}
                            autoComplete="nickname"
                            spellCheck={false}
                        />
                        <span className="settings-desc">
                            Shown on pulls you share, next to your ID <span className="share-fp">#{player.fingerprint}</span>.
                        </span>
                    </label>
                </div>
            </section>

            <section className="settings-group">
                <h3 className="section-title">Experience</h3>
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

            <section className="settings-group">
                <h3 className="section-title">Save data</h3>
                <div className="settings-panel">
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
                                        setImportNote('Kept your save.');
                                    }}
                                >
                                    Keep mine
                                </button>
                                <button type="button" className="btn btn--primary btn--sm" onClick={() => runImport(pendingImport)}>
                                    Replace
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
                                    <button type="button" ref={keepRef} className="btn btn--secondary btn--sm" onClick={() => showBringResult('kept')}>
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
        </Sheet>
    );
};

/** A card flip at the effects volume just chosen, so you hear what you picked. */
const playSample = (value: number) => {
    if (value === 0) return;
    const sample = new Audio(CARD_FLIP_SRC);
    sample.volume = effectsLevel(value);
    sample.play().catch(() => {});
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
