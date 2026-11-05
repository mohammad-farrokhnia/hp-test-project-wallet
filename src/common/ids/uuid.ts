const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @function isUuid
 * @param value - any string, typically a path parameter
 * @returns true when it is shaped like a UUID (any version), so a lookup cannot fail on a malformed id
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
