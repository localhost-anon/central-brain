import { describe, it, expect } from 'vitest';
import { createFastEmbedder, cosine } from '../src/services/embedder.js';

describe('fastembed real model (downloads once to ~/.central-brain/models)', () => {
  it('embeds semantically: paraphrase beats unrelated', { timeout: 300000 }, async () => {
    const e = createFastEmbedder();
    const [nas, para, other] = await e.embed([
      'TrueNAS server hosts the Seafile file sync service',
      'network attached storage box running a document sync app',
      'candlestick chart colors for the trading dashboard',
    ]);
    expect(nas.length).toBeGreaterThan(100);
    expect(cosine(nas, para)).toBeGreaterThan(cosine(nas, other));
  });
});
