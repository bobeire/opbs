export type InterfaceMode = 'advanced' | 'standard';

/**
 * Renderer-side normalizer for the persisted interface mode. Anything other
 * than the explicit opt-in value means Advanced, including missing settings
 * from older installs and malformed IPC payloads.
 */
export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  return value === 'standard' ? 'standard' : 'advanced';
}
