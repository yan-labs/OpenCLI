import { describe, expect, it } from 'vitest';
import { parseSnapshotHeader, parseSnapshotRefs } from './snapshot-parse.js';

const SAMPLE = `url: https://example.com/
title: Example Domain
viewport: 1280x900
---
<div>
  <h1>Example Domain</h1>
  [1]<a href=/learn>Learn more</a>
  [2]<input type=text name=custname placeholder=Your name />
  [3]<input type=submit value=Submit order />
  [4]<button type=button>Cancel</button>
`;

describe('parseSnapshotHeader', () => {
  it('extracts url and title from the header block', () => {
    expect(parseSnapshotHeader(SAMPLE)).toEqual({ url: 'https://example.com/', title: 'Example Domain' });
  });

  it('returns empty strings when headers are missing', () => {
    expect(parseSnapshotHeader('no headers here')).toEqual({ url: '', title: '' });
  });

  it('does not let a blank title: line swallow the next line (real pages with no <title>, e.g. httpbin forms)', () => {
    const text = 'url: https://httpbin.org/forms/post\ntitle: \nviewport: 1280x723\n---\n';
    expect(parseSnapshotHeader(text)).toEqual({ url: 'https://httpbin.org/forms/post', title: '' });
  });
});

describe('parseSnapshotRefs', () => {
  const refs = parseSnapshotRefs(SAMPLE);

  it('parses every [N]<tag> line into a ref', () => {
    expect(refs.map((r) => r.ref)).toEqual(['1', '2', '3', '4']);
  });

  it('captures tag name lowercased', () => {
    expect(refs[0].tag).toBe('a');
    expect(refs[1].tag).toBe('input');
  });

  it('captures inline text for open/close elements', () => {
    expect(refs[0].text).toBe('Learn more');
    expect(refs[3].text).toBe('Cancel');
  });

  it('captures attributes for self-closed elements, with empty text', () => {
    expect(refs[1].attrs.type).toBe('text');
    expect(refs[1].attrs.name).toBe('custname');
    expect(refs[1].text).toBe('');
  });

  it('captures href and value attributes', () => {
    expect(refs[0].attrs.href).toBe('/learn');
    expect(refs[2].attrs.value).toBe('Submit order');
  });

  it('skips non-ref lines silently', () => {
    expect(parseSnapshotRefs('url: x\ntitle: y\n---\nplain text\n')).toEqual([]);
  });
});
