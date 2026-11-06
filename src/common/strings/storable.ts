/** The character PostgreSQL `text` cannot store. */
const NUL = '\u0000';

/**
 * @function storable
 * @description Replaces NUL characters with U+FFFD: PostgreSQL refuses them in `text`, and a delivery or file that carries one must still be recorded, not turn into a 500.
 * @param text - any text that came from outside
 * @returns the same text, safe to store
 */
export function storable(text: string): string {
  return text.split(NUL).join('\uFFFD');
}
