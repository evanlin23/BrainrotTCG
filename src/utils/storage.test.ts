import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredData, removeStoredData, setStoredData } from './storage';

describe('storage helpers', () => {
  const TEST_KEY = 'test_storage_key';
  const DEFAULT_VAL = { default: true };

  let mockLocalStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getStoredData', () => {
    it('returns parsed objects and arrays for valid stored JSON and queries the exact key', () => {
      const objectKey = 'test_object_key';
      const arrayKey = 'test_array_key';
      const sampleObject = { id: 1, name: 'Brainrot' };
      const sampleArray = [1, 2, { a: 'b' }];

      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === objectKey) return JSON.stringify(sampleObject);
        if (key === arrayKey) return JSON.stringify(sampleArray);
        return null;
      });

      expect(getStoredData(objectKey, DEFAULT_VAL)).toEqual(sampleObject);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(objectKey);

      expect(getStoredData(arrayKey, [])).toEqual(sampleArray);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(arrayKey);
    });

    it.each([
      ['missing key (null)', null],
      ['empty string', ''],
      ['malformed JSON', '{ invalid json'],
      ['null JSON', 'null'],
      ['number JSON primitive', '123'],
      ['string JSON primitive', '"just a string"'],
      ['boolean JSON primitive', 'true'],
      ['boolean false JSON primitive', 'false'],
    ])('returns fallback for %s', (_description, rawValue) => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === TEST_KEY) return rawValue;
        return null;
      });
      expect(getStoredData(TEST_KEY, DEFAULT_VAL)).toEqual(DEFAULT_VAL);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(TEST_KEY);
    });

    it('returns fallback when localStorage read is denied or throws an exception', () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === TEST_KEY) {
          throw new Error('SecurityError: Access denied');
        }
        return null;
      });

      expect(getStoredData(TEST_KEY, DEFAULT_VAL)).toEqual(DEFAULT_VAL);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(TEST_KEY);
    });
  });

  describe('setStoredData', () => {
    it('serializes and writes valid data to localStorage', () => {
      const dataToSave = { foo: 'bar', numbers: [1, 2, 3] };

      expect(setStoredData(TEST_KEY, dataToSave)).toBe(true);

      expect(mockLocalStorage.setItem).toHaveBeenCalledOnce();
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(TEST_KEY, JSON.stringify(dataToSave));
    });

    it('catches and logs error when localStorage setItem is denied or throws QuotaExceededError', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const storageError = new Error('QuotaExceededError');
      mockLocalStorage.setItem.mockImplementation(() => {
        throw storageError;
      });

      let saved: boolean | undefined;
      expect(() => { saved = setStoredData(TEST_KEY, { foo: 'bar' }); }).not.toThrow();
      expect(saved).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `Failed to save to localStorage key "${TEST_KEY}":`,
        storageError,
      );
    });

    it.each(['QuotaExceededError', 'SecurityError'])('contains a %s DOMException and reports the write as failed', (name) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLocalStorage.setItem.mockImplementation(() => {
        throw new DOMException('Denied', name);
      });

      expect(setStoredData(TEST_KEY, { packsOpened: 1 })).toBe(false);
      expect(mockLocalStorage.setItem).toHaveBeenCalledOnce();
    });

    it('catches and logs error on JSON serialization failure without performing partial writes', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const circularObj: Record<string, unknown> = {};
      circularObj.self = circularObj;

      let saved: boolean | undefined;
      expect(() => { saved = setStoredData(TEST_KEY, circularObj); }).not.toThrow();
      expect(saved).toBe(false);
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `Failed to save to localStorage key "${TEST_KEY}":`,
        expect.any(TypeError),
      );
    });
  });

  describe('removeStoredData', () => {
    it('removes item for the intended key from localStorage', () => {
      removeStoredData(TEST_KEY);

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith(TEST_KEY);
    });

    it('catches and logs error when removeItem is denied or throws', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const storageError = new Error('SecurityError: Access denied');
      mockLocalStorage.removeItem.mockImplementation(() => {
        throw storageError;
      });

      expect(() => removeStoredData(TEST_KEY)).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `Failed to remove localStorage key "${TEST_KEY}":`,
        storageError,
      );
    });
  });
});
