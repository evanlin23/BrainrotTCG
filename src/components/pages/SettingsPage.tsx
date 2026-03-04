import { useRef } from 'react';
import { STORAGE_KEYS } from '../../constants';
import type { Settings } from '../../types';
import '../../styles/Settings.css';

interface SettingsPageProps {
    settings: Settings;
    onSettingsChange: (settings: Settings) => void;
    onClose: () => void;
    onImportSave: (data: string) => void;
}

const SettingsPage = ({ settings, onSettingsChange, onClose, onImportSave }: SettingsPageProps) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleToggleSound = () => {
        onSettingsChange({ ...settings, soundEnabled: !settings.soundEnabled });
    };

    const handleToggleParticles = () => {
        onSettingsChange({ ...settings, particlesEnabled: !settings.particlesEnabled });
    };

    const handleExportSave = () => {
        const saveData = {
            collection: localStorage.getItem(STORAGE_KEYS.COLLECTION),
            achievements: localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS),
            stats: localStorage.getItem(STORAGE_KEYS.STATS),
            hallOfFame: localStorage.getItem(STORAGE_KEYS.HALL_OF_FAME),
            settings: localStorage.getItem(STORAGE_KEYS.SETTINGS),
            exportedAt: new Date().toISOString(),
            version: 1,
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

    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const content = event.target?.result as string;
            onImportSave(content);
        };
        reader.readAsText(file);

        // Reset input so the same file can be selected again
        e.target.value = '';
    };

    return (
        <div className="settings-page">
            <div className="settings-header">
                <h2>Settings</h2>
                <button className="settings-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="settings-content">
                <div className="settings-section">
                    <h3>Audio & Visuals</h3>

                    <div className="settings-option">
                        <div className="settings-option-info">
                            <span className="settings-option-label">Sound Effects</span>
                            <span className="settings-option-desc">Card sounds, music, and effects</span>
                        </div>
                        <button
                            className={`settings-toggle ${settings.soundEnabled ? 'active' : ''}`}
                            onClick={handleToggleSound}
                        >
                            <span className="toggle-slider" />
                        </button>
                    </div>

                    <div className="settings-option">
                        <div className="settings-option-info">
                            <span className="settings-option-label">Particles</span>
                            <span className="settings-option-desc">Sparks, confetti, and visual effects</span>
                        </div>
                        <button
                            className={`settings-toggle ${settings.particlesEnabled ? 'active' : ''}`}
                            onClick={handleToggleParticles}
                        >
                            <span className="toggle-slider" />
                        </button>
                    </div>
                </div>

                <div className="settings-section">
                    <h3>Save Data</h3>

                    <div className="settings-option">
                        <div className="settings-option-info">
                            <span className="settings-option-label">Export Save</span>
                            <span className="settings-option-desc">Download your progress as a text file</span>
                        </div>
                        <button className="settings-btn" onClick={handleExportSave}>
                            Export
                        </button>
                    </div>

                    <div className="settings-option">
                        <div className="settings-option-info">
                            <span className="settings-option-label">Import Save</span>
                            <span className="settings-option-desc">Load progress from a text file</span>
                        </div>
                        <button className="settings-btn" onClick={handleImportClick}>
                            Import
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".txt,.json"
                            onChange={handleFileChange}
                            style={{ display: 'none' }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
