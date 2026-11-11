import { LANGUAGE_DETECTION_MIN_CONFIDENCE } from '../constants';
import type { LanguageDetectionData } from '../types';

type Detection =
  | Partial<Pick<LanguageDetectionData, 'detectedLanguage' | 'detectedConfidence' | 'match'>>
  | null
  | undefined;

/**
 * The detected language, or null when the detection is missing or not confident enough.
 * A detection that agrees with the declared language counts at any confidence.
 */
export function confidentLanguage(ld: Detection): string | null {
  if (!ld?.detectedLanguage) return null;
  if (ld.match === true) return ld.detectedLanguage;
  return (ld.detectedConfidence ?? 0) > LANGUAGE_DETECTION_MIN_CONFIDENCE ? ld.detectedLanguage : null;
}

/** True only for a confident detection that disagrees with the declared language. */
export function isConfidentLanguageMismatch(ld: Detection): boolean {
  return ld?.match === false && (ld.detectedConfidence ?? 0) > LANGUAGE_DETECTION_MIN_CONFIDENCE;
}
