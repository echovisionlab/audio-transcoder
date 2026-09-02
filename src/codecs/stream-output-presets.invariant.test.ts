import { describe, expect, it, vi } from 'vitest';

vi.mock('./aiff.js', () => ({
  AIFF_OUTPUT_PRESETS: Object.freeze([]),
}));

describe('stream output preset invariants', () => {
  it('fails module initialization when the shared AIFF presets drift', async () => {
    await expect(import('./stream-output-presets.js')).rejects.toThrow(
      'Built-in AIFF preset "aiff-pcm16" is inconsistent.',
    );
  });
});
