// lib/search/select.js - Local boolean filter mirroring the search spec.
//
// Used by the ENSURE stage of the search pipeline:
//   SEARCH → DEDUPLICATE → ENRICH → ENSURE → persist
//
// ENSURE re-applies the original spec locally against each item's
// title + abstract + journal to drop items the databases ranked in for
// peripheral signals (Scopus tag noise, Google Scholar OCR matches in
// references, MeSH cross-references, etc.) but that don't actually
// contain the query terms.
//
// Direct port of select_articles() from the Python ICompletist package
// (core.py:24). Substring matching is intentional — matches Python
// behavior exactly. Word-boundary matching can over-trim on terms that
// share prefixes with their derivatives ("pathogen" vs "pathogenesis").
//
// CAVEAT: items with no abstract — e.g. PubMed esummary results before
// the ENRICH stage fills them in — only have title (+ journal) text to
// match against. Multi-group queries that depend on abstract content
// will drop these items. Once the Crossref / S2 / Scopus enrichment
// cascade lands in v2.1, this caveat disappears because every kept
// item will carry an abstract before reaching ENSURE.

export function selectArticles(items, spec) {
  if (!spec || !Array.isArray(spec.groups) || !spec.groups.length) {
    return items;
  }

  const matchGroup = (text, group) => {
    const op = (group.internal || "OR").toUpperCase();
    const terms = group.terms.map((t) => t.toLowerCase());
    if (!terms.length) return false;
    return op === "AND"
      ? terms.every((t) => text.includes(t))
      : terms.some((t) => text.includes(t));
  };

  const matches = (item) => {
    const text = [item.title, item.abstract, item.journal]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const groups = spec.groups;
    let result = matchGroup(text, groups[0]);
    for (const g of groups.slice(1)) {
      const ext = (g.external || "AND").toUpperCase();
      const m = matchGroup(text, g);
      if (ext === "NOT" || ext === "AND NOT") result = result && !m;
      else if (ext === "OR") result = result || m;
      else result = result && m;
    }
    return result;
  };

  return items.filter(matches);
}
