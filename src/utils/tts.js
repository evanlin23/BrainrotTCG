/**
 * Create a pre-configured utterance for later playback.
 *
 * @param {string} text - The text to speak.
 * @param {Object} options - Speech options.
 * @returns {SpeechSynthesisUtterance} The configured utterance.
 */
export const createUtterance = (text, options = {}) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.pitch = options.pitch || 1;
    utterance.rate = options.rate || 1;
    utterance.volume = options.volume || 1;
    utterance.lang = options.lang || 'en-US';
    return utterance;
};

/**
 * Speak a pre-created utterance.
 *
 * @param {SpeechSynthesisUtterance} utterance - The utterance to speak.
 * @returns {Promise<void>} Resolves when speech ends.
 */
export const speakUtterance = (utterance) => {
    return new Promise((resolve, reject) => {
        if (!('speechSynthesis' in window)) {
            reject(new Error('Speech Synthesis not supported'));
            return;
        }

        window.speechSynthesis.cancel();

        utterance.onend = () => resolve();
        utterance.onerror = (event) => reject(event);

        window.speechSynthesis.speak(utterance);
    });
};

/**
 * Simple text-to-speech helper function using the Web Speech API.
 *
 * @param {string} text - The text to speak.
 * @param {Object} options - Speech options.
 * @param {number} [options.pitch=1] - Pitch of the voice (0 to 2).
 * @param {number} [options.rate=1] - Rate of speech (0.1 to 10).
 * @param {number} [options.volume=1] - Volume (0 to 1).
 * @param {string} [options.lang='en-US'] - Language code.
 */
export const speak = (text, options = {}) => {
    if (!('speechSynthesis' in window)) {
        return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    // Apply options with fallbacks
    utterance.pitch = options.pitch || 1;
    utterance.rate = options.rate || 1;
    utterance.volume = options.volume || 1;
    utterance.lang = options.lang || 'en-US';

    window.speechSynthesis.speak(utterance);
};
