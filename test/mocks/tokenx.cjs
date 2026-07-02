/**
 * Minimal CJS stand-in for the ESM-only `tokenx` package, used ONLY by Jest
 * (see moduleNameMapper). @mastra/core's TokenLimiterProcessor imports it for
 * token ESTIMATION; the real heuristic quality is irrelevant to unit tests, so
 * a chars/4 approximation keeps behavior sane. At app runtime the ESM build of
 * @mastra/core loads the real package — this shim never ships.
 */
function approximateTokenSize(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

function estimateTokenCount(text) {
  return approximateTokenSize(text);
}

function isWithinTokenLimit(text, limit) {
  return approximateTokenSize(text) <= limit;
}

function sliceByTokens(text, start, end) {
  const s = String(text ?? '');
  const from = start !== undefined ? start * 4 : undefined;
  const to = end !== undefined ? end * 4 : undefined;
  return s.slice(from, to);
}

function splitByTokens(text, size) {
  const s = String(text ?? '');
  const chunk = Math.max(1, size * 4);
  const out = [];
  for (let i = 0; i < s.length; i += chunk) out.push(s.slice(i, i + chunk));
  return out;
}

module.exports = {
  approximateTokenSize,
  estimateTokenCount,
  isWithinTokenLimit,
  sliceByTokens,
  splitByTokens,
};
