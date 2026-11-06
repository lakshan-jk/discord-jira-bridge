/**
 * Atlassian Document Format (ADF) helpers.
 *
 * JIRA Cloud v3 rejects plain strings for `description` and comment bodies — they
 * must be an ADF document (a JSON node tree). ADF is confined to this module: the
 * `JiraClient` interface speaks plain text, and the client calls these converters
 * at the single point where it builds a request payload. Nothing outside `jira/`
 * ever touches ADF.
 */

/** A minimal structural view of ADF. Loose on purpose; we only emit a small subset. */
export interface AdfDocument {
  readonly version: 1;
  readonly type: 'doc';
  readonly content: readonly AdfNode[];
}

export interface AdfNode {
  readonly type: string;
  readonly content?: readonly AdfNode[];
  readonly text?: string;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  readonly attrs?: Record<string, unknown>;
}

/** A single run of text within a paragraph. */
function textNode(text: string): AdfNode {
  return { type: 'text', text };
}

/**
 * Turn one line of plain text into a paragraph node. ADF requires a paragraph to
 * have no empty `text` nodes, so a blank line becomes an empty paragraph (valid,
 * renders as a gap) rather than a paragraph containing an empty text node.
 */
function paragraph(line: string): AdfNode {
  return line.length === 0
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [textNode(line)] };
}

/**
 * Split text into ADF paragraphs, one per line. An empty document still needs at
 * least one (empty) paragraph to be valid ADF, so we never emit zero-content docs.
 */
function paragraphsFromText(text: string): AdfNode[] {
  if (text.length === 0) {
    return [paragraph('')];
  }
  return text.split('\n').map(paragraph);
}

/** Convert a plain-text block into an ADF document, one paragraph per line. */
export function textToAdf(text: string): AdfDocument {
  return { version: 1, type: 'doc', content: paragraphsFromText(text) };
}

/**
 * Build the ADF body for a synced comment: an attribution line naming the original
 * Discord author (service-account model, design decision #1/#6) followed by the
 * message text. Because every API action is attributed to the single service
 * account in JIRA, the real author is preserved here in the body.
 *
 * Handles multi-line bodies (one paragraph per line) and empty bodies (attribution
 * line only).
 */
export function commentToAdf(input: {
  readonly authorDisplayName: string;
  readonly body: string;
}): AdfDocument {
  const attribution: AdfNode = {
    type: 'paragraph',
    content: [
      { type: 'text', text: `${input.authorDisplayName} via Discord:`, marks: [{ type: 'strong' }] },
    ],
  };

  const bodyParagraphs = input.body.length === 0 ? [] : input.body.split('\n').map(paragraph);

  return { version: 1, type: 'doc', content: [attribution, ...bodyParagraphs] };
}
