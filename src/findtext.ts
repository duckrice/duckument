// Finding words in a page's text. A page's text comes as a list of pieces
// (one per run of text pdf.js found); a match can start in one piece and end
// in another.

export interface TextPiece {
  str: string;
  /** Whether a line break follows the piece. */
  eol: boolean;
}

/** A position inside a piece. */
export interface TextPoint {
  piece: number;
  offset: number;
}

export interface TextMatch {
  start: TextPoint;
  /** Just after the last matched character. */
  end: TextPoint;
}

/** Lower-cases and folds runs of white space into one space, which is how the search box text is compared too. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Every place `query` occurs in the pieces, ignoring case and differences in spacing. */
export function findInPieces(pieces: TextPiece[], query: string): TextMatch[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];

  // The page's text as one string, with where each character came from.
  let text = "";
  const from: (TextPoint | null)[] = [];
  let lastWasSpace = true;
  pieces.forEach((piece, index) => {
    for (let offset = 0; offset < piece.str.length; offset++) {
      const ch = piece.str[offset];
      const space = /\s/.test(ch);
      if (space && lastWasSpace) continue;
      text += space ? " " : ch;
      from.push({ piece: index, offset });
      lastWasSpace = space;
    }
    if (piece.eol && !lastWasSpace) {
      text += " ";
      from.push(null);
      lastWasSpace = true;
    }
  });
  const haystack = text.toLocaleLowerCase();

  const matches: TextMatch[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    // Skip a line break at either edge; inside a match it just separates words.
    let first = at;
    while (first < at + needle.length && !from[first]) first++;
    let last = at + needle.length - 1;
    while (last > first && !from[last]) last--;
    const start = from[first];
    const end = from[last];
    if (!start || !end) continue;
    matches.push({ start, end: { piece: end.piece, offset: end.offset + 1 } });
  }
  return matches;
}
