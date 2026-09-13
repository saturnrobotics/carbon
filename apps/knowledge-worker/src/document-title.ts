/**
 * Proposes the title a reviewer sees first, from what the capture actually knows.
 *
 * The immutable object is content-addressed, so the last segment of its key is a
 * sha256 and is never a title. The uploader's own file name is, and where there
 * is no name — a URL acquisition, a re-parse — the document's first page is the
 * only remaining evidence. When neither yields anything a person would keep, no
 * title is proposed at all: an empty required field asks the reviewer for one,
 * where a wrong one invites them to accept it.
 */

/** The longest proposal `reviewedManualMetadataSchema.title` will accept. */
const MAXIMUM_TITLE = 500;
/** A heading longer than this is a paragraph the layout happened to start with. */
const MAXIMUM_HEADING = 200;
const MINIMUM_HEADING = 3;
/** A title lives in the first few lines of page one or it is not a title. */
const HEADING_LINES = 5;
const LETTER = /\p{L}/u;

/** Page furniture that leads a first page often enough to be worth refusing by name. */
const FURNITURE = [
  /^page\b/i,
  /^\d+(\s*(of|\/)\s*\d+)?$/i,
  /^(figure|table|fig\.|tbl\.)\b/i,
  /^(copyright|confidential|all rights reserved)\b/i,
  /^©/,
  /^(https?:\/\/|www\.)/i,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/
];

function collapse(value: string): string {
  // Control characters included: a file name is caller-supplied text.
  return value.replace(/[\p{C}\s]+/gu, " ").trim();
}

function letters(value: string): number {
  return [...value].filter((character) => LETTER.test(character)).length;
}

/**
 * True for a value that is a content digest wearing a title's clothes.
 *
 * The defect this guards against proposed an object key's sha256. The check is
 * deliberately wider than that one shape — any long unbroken hexadecimal run is
 * a digest, whatever produced it — because a name that reaches here from a
 * download of a content-addressed file is the same unreadable string.
 */
export function looksLikeContentHash(value: string): boolean {
  return /^[0-9a-f]{32,}$/i.test(value.replace(/[\s_-]/g, ""));
}

/**
 * The stem of a file name or of the final path segment of an acquisition URL.
 *
 * Kept close to what the uploader typed — the extension goes, whitespace is
 * collapsed, nothing else is rewritten — so a deliberate name such as
 * `ACME-1200` survives intact.
 */
export function titleFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let candidate = name;
  if (/^https?:\/\//i.test(candidate)) {
    let pathname: string;
    try {
      pathname = new URL(candidate).pathname;
    } catch {
      return undefined;
    }
    try {
      candidate = decodeURIComponent(pathname);
    } catch {
      candidate = pathname;
    }
  }
  const segment = candidate.split(/[/\\]/).map(collapse).filter(Boolean).at(-1);
  if (!segment) return undefined;
  // Collapsed first: an extension is only trailing once the whitespace is gone.
  const stem = segment.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  const title = (stem || segment).slice(0, MAXIMUM_TITLE).trim();
  if (!title || !LETTER.test(title) || looksLikeContentHash(title))
    return undefined;
  return title;
}

/**
 * The first line of page one that reads as a heading rather than as furniture.
 *
 * Only the opening lines are considered: a title that is not at the top of the
 * first page is a guess, and a guess is what the empty field already says.
 */
export function titleFromFirstPage(text: string): string | undefined {
  const page = text.split("\f")[0] ?? "";
  const lines = page
    .split(/\r?\n/)
    .map(collapse)
    .filter(Boolean)
    .slice(0, HEADING_LINES);
  return lines.find((line) => {
    if (line.length < MINIMUM_HEADING || line.length > MAXIMUM_HEADING)
      return false;
    if (letters(line) < MINIMUM_HEADING) return false;
    // A rule, a barcode or a row of dot leaders is mostly not letters.
    if (letters(line) * 4 < line.length) return false;
    if (looksLikeContentHash(line)) return false;
    return !FURNITURE.some((pattern) => pattern.test(line));
  });
}

export type ProposedTitle = {
  value: string;
  /** Present only when the document itself says so, and then it cites the page. */
  evidence?: { page: number; text: string };
};

/**
 * The title to propose, or nothing.
 *
 * The name wins over the first page. It is the one signal a person chose on
 * purpose for this document, where a heading is an inference about layout that
 * OCR can get wrong; the first page covers the captures that have no name at
 * all, which is where the alternative is a blank field rather than a good one.
 */
export function proposedTitle(input: {
  name?: string;
  text?: string;
}): ProposedTitle | undefined {
  const named = titleFromName(input.name);
  if (named) return { value: named };
  const heading = input.text ? titleFromFirstPage(input.text) : undefined;
  if (heading) return { value: heading, evidence: { page: 1, text: heading } };
  return undefined;
}
