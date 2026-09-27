import { describe, it, expect } from 'vitest';
import { fakeEmbedder, toBlob, fromBlob, cosine } from '../src/services/embedder.js';

describe('embedder utils + fake', () => {
  it('round-trips vectors through Buffer', () => {
    const v = new Float32Array([0.25, -1.5, 3]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.25, -1.5, 3]);
  });

  it('cosine behaves', () => {
    const a = new Float32Array([1, 0]);
    expect(cosine(a, new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(a, new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(a, new Float32Array([0, 0]))).toBe(0);
  });

  it('fake embedder is deterministic and overlap-sensitive', async () => {
    const e = fakeEmbedder();
    const [a1, a2, b] = await e.embed([
      'seafile file sync server', 'seafile sync', 'trading bot latency']);
    const [a1b] = await e.embed(['seafile file sync server']);
    expect(Array.from(a1)).toEqual(Array.from(a1b));
    expect(cosine(a1, a2)).toBeGreaterThan(cosine(a1, b));
  });
});
