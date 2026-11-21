import { describe, expect, it } from 'vitest';
import { parseJsonOutput, runCli } from '../e2e/helpers.js';

// One representative endpoint per public API family. Offline adapter tests own
// parsing and pagination; these checks detect live service/schema drift.
describe('public API health', () => {
  it.each([
    { args: ['hackernews', 'top', '--limit', '3'], fields: ['title', 'score', 'rank'] },
    { args: ['v2ex', 'hot', '--limit', '3'], fields: ['title'] },
    { args: ['apple-podcasts', 'search', 'technology', '--limit', '3'], fields: ['id', 'title', 'author'] },
    { args: ['dictionary', 'search', 'serendipity'], fields: ['word', 'definition'] },
  ])('$args returns structured rows', async ({ args, fields }) => {
    const result = await runCli([...args, '-f', 'json']);
    expect(result.code, result.stderr).toBe(0);
    const rows = parseJsonOutput(result.stdout);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const field of fields) expect(rows[0]).toHaveProperty(field);
  }, 30_000);
});
