// Shared search-filter builders, replacing the hand-duplicated `new RegExp(...)` + `$or` block
// that used to be written out separately in every list() controller.

function escapeRegex(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Plain string/enum fields - direct case-insensitive substring match.
function regexOr(term, fields) {
  const re = new RegExp(escapeRegex(term.trim()), 'i');
  return fields.map((f) => ({ [f]: re }));
}

// Number fields (amounts, quantities, totals) - Mongo regex can't match a Number directly, so
// cast to string first via $expr/$toString. Lets "1580" find an MRC of 1580, "90" find a stage
// like "90% - Closing" via the string fields above, etc.
function numericRegexOr(term, fields) {
  const re = escapeRegex(term.trim());
  return fields.map((f) => ({
    $expr: { $regexMatch: { input: { $toString: `$${f}` }, regex: re, options: 'i' } },
  }));
}

module.exports = { regexOr, numericRegexOr };
