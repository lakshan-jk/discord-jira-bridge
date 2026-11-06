import { describe, expect, it } from 'vitest';
import { commentToAdf, textToAdf } from './adf.js';

describe('textToAdf', () => {
  it('produces one paragraph per line', () => {
    const doc = textToAdf('one\ntwo');
    expect(doc).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
  });

  it('never emits a zero-content doc for empty text', () => {
    const doc = textToAdf('');
    expect(doc.content).toEqual([{ type: 'paragraph' }]);
  });
});

describe('commentToAdf', () => {
  it('leads with a bold attribution line, then the body', () => {
    const doc = commentToAdf({ authorDisplayName: 'Ada', body: 'hello' });
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Ada via Discord:', marks: [{ type: 'strong' }] }],
    });
    expect(doc.content[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] });
  });

  it('handles multi-line bodies as separate paragraphs', () => {
    const doc = commentToAdf({ authorDisplayName: 'Ada', body: 'a\nb' });
    expect(doc.content).toHaveLength(3); // attribution + 2 lines
  });

  it('handles an empty body as attribution only', () => {
    const doc = commentToAdf({ authorDisplayName: 'Ada', body: '' });
    expect(doc.content).toHaveLength(1);
  });
});
