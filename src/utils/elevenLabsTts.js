/**
 * ElevenLabs TTS integration
 */

const ELEVEN_API_KEY = 'sk_e6a9ff705714738b409405c241fb07781a8a9f752cbfb891';

// Harry - Fierce Warrior voice (similar vibe to Wukong)
let VOICE_ID = 'SOYHLrjzK2X1ezoPC6cr';

/**
 * Set the voice ID to use
 */
export const setVoiceId = (id) => {
    VOICE_ID = id;
};

/**
 * Generate speech using ElevenLabs API
 * @param {string} text - Text to speak
 * @returns {Promise<HTMLAudioElement>} Audio element ready to play
 */
export const elevenSpeak = async (text) => {
    console.log('ElevenLabs TTS: Speaking:', text);

    try {
        const response = await fetch(`/api/eleven/v1/text-to-speech/${VOICE_ID}`, {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVEN_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                }
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('ElevenLabs TTS error:', error);
            throw new Error(`ElevenLabs TTS failed: ${response.status}`);
        }

        // Get audio blob and create playable audio
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        return audio;
    } catch (error) {
        console.error('ElevenLabs TTS error:', error);
        throw error;
    }
};

/**
 * Clone a voice from audio files
 * @param {string} name - Name for the cloned voice
 * @param {File[]} files - Audio files to clone from
 * @returns {Promise<string>} The new voice ID
 */
export const cloneVoice = async (name, files) => {
    const formData = new FormData();
    formData.append('name', name);

    files.forEach(file => {
        formData.append('files', file);
    });

    const response = await fetch('/api/eleven/v1/voices/add', {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVEN_API_KEY,
        },
        body: formData,
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Voice cloning failed: ${error}`);
    }

    const data = await response.json();
    return data.voice_id;
};

/**
 * List available voices
 * @returns {Promise<Array>} List of voices
 */
export const listVoices = async () => {
    const response = await fetch('/api/eleven/v1/voices', {
        headers: {
            'xi-api-key': ELEVEN_API_KEY,
        },
    });

    if (!response.ok) {
        throw new Error('Failed to list voices');
    }

    const data = await response.json();
    return data.voices;
};
