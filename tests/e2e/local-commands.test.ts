import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseJsonOutput, runCli } from './helpers.js';

describe('offline adapter CLI contracts', () => {
  it('paperreview submit dry-run validates a local PDF without remote upload', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-paperreview-'));
    try {
      const pdfPath = path.join(tempDir, 'sample.pdf');
      await fs.writeFile(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 1)]));

      const { stdout, code } = await runCli([
        'paperreview',
        'submit',
        pdfPath,
        '--email',
        'test@example.com',
        '--venue',
        'RAL',
        '--dry-run',
        'true',
        '-f',
        'json',
      ]);

      expect(code).toBe(0);
      const data = parseJsonOutput(stdout);
      expect(data).toMatchObject({
        status: 'dry-run',
        file: 'sample.pdf',
        email: 'test@example.com',
        venue: 'RAL',
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('yollomi models returns model list with all types', async () => {
    const { stdout, code } = await runCli(['yollomi', 'models', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(10);
    expect(data[0]).toHaveProperty('type');
    expect(data[0]).toHaveProperty('model');
    expect(data[0]).toHaveProperty('credits');
    expect(data[0]).toHaveProperty('description');
    const types = new Set(data.map((d: any) => d.type));
    expect(types.has('image')).toBe(true);
    expect(types.has('video')).toBe(true);
    expect(types.has('tool')).toBe(true);
  }, 30_000);

  it('yollomi models --type image filters correctly', async () => {
    const { stdout, code } = await runCli(['yollomi', 'models', '--type', 'image', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d: any) => d.type === 'image')).toBe(true);
  }, 30_000);
});
