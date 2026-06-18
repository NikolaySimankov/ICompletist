// lib/search/spec.js - Shared query spec used by every search source.
//
// The spec object — produced by parseQueryLines() — looks like:
//   {
//     field: "title-abs-keywords",    // logical field name; each source maps
//                                     // it to its native syntax
//     yearFrom: 2020,                 // optional
//     yearTo: 2024,                   // optional
//     doctype: ["article", "review"], // optional, source-specific
//     groups: [
//       { terms: ["plant", "vegetation"], internal: "OR" },
//       { terms: ["pathogen", "disease"], internal: "OR", external: "AND" },
//       { terms: ["wheat", "rice"],       internal: "OR", external: "AND NOT" },
//     ]
//   }
//
// Line-per-group syntax (what the user types):
//
//   plant OR vegetation OR crop
//   AND pathogen OR disease OR pest
//   AND NOT wheat OR rice
//
// Rules:
//   - First line is the first group (no external operator).
//   - Each subsequent line MUST start with AND, OR, AND NOT, NOT (case-insensitive).
//     "NOT" is normalized to "AND NOT".
//   - Within a line, terms are separated by OR or AND (default OR if omitted).
//   - A term wrapped in "double quotes" is treated as a phrase; otherwise a
//     whitespace-separated word.
//   - Blank lines are ignored.
//   - A line starting with `#` is a comment.

const EXTERNAL_OPS = ["AND NOT", "AND", "OR", "NOT"];

export class QueryParseError extends Error {}

function stripComment(line) {
  return line.split("#")[0].trim();
}

function splitTerms(rest) {
  // Tokenize into terms separated by AND/OR.
  // Quoted phrases are preserved as single terms.
  const tokens = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);

  // Walk tokens: alternating term, op, term, op, ...
  const terms = [];
  const opsSeen = new Set();
  let lastInternal = "OR";
  let expectOp = false;
  for (const tok of tokens) {
    const u = tok.toUpperCase();
    if (u === "AND" || u === "OR") {
      if (!expectOp) throw new QueryParseError(`Unexpected operator "${tok}" at start of group`);
      opsSeen.add(u);
      lastInternal = u;
      expectOp = false;
    } else {
      terms.push(tok);
      expectOp = true;
    }
  }
  if (opsSeen.size > 1) {
    throw new QueryParseError("A single group can't mix AND and OR — split into separate lines");
  }
  return { terms, internal: lastInternal };
}

export function parseQueryLines(text) {
  const lines = String(text || "").split(/\r?\n/)
    .map(stripComment)
    .filter((l) => l.length > 0);

  if (!lines.length) return { groups: [] };

  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    let external = null;
    if (i > 0) {
      // Try to peel off an external operator from the start.
      const upper = line.toUpperCase();
      let matched = null;
      for (const op of EXTERNAL_OPS) {
        if (upper === op || upper.startsWith(op + " ")) { matched = op; break; }
      }
      if (!matched) {
        throw new QueryParseError(`Line ${i + 1} must begin with AND, OR, AND NOT, or NOT — got "${line.split(/\s/)[0]}"`);
      }
      external = matched === "NOT" ? "AND NOT" : matched;
      line = line.slice(matched.length).trim();
    }

    if (!line) throw new QueryParseError(`Line ${i + 1} has no terms after operator`);

    const { terms, internal } = splitTerms(line);
    if (!terms.length) throw new QueryParseError(`Line ${i + 1} has no terms`);

    const group = { terms, internal };
    if (external) group.external = external;
    groups.push(group);
  }

  return { groups };
}

// Build the complete spec from form inputs + parsed query text.
export function buildSpec({ queryText, yearFrom, yearTo, field, doctype }) {
  const parsed = parseQueryLines(queryText);
  const spec = { groups: parsed.groups };
  if (field) spec.field = field;
  if (yearFrom) spec.yearFrom = parseInt(yearFrom, 10);
  if (yearTo) spec.yearTo = parseInt(yearTo, 10);
  if (Array.isArray(doctype) && doctype.length) spec.doctype = doctype;
  return spec;
}
