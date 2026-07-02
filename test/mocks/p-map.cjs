/**
 * Minimal CJS stand-in for the ESM-only `p-map` package, used ONLY by Jest
 * (see moduleNameMapper). @mastra/core's CJS build `require`s p-map, whose
 * real entry is ESM (`export default …`) that Jest cannot parse. At app
 * runtime the ESM build of @mastra/core loads the real package — this shim
 * never ships.
 *
 * Sequential on purpose: `concurrency` does not matter for unit tests.
 * Supports the `pMapSkip` sentinel like the real library.
 */
const pMapSkip = Symbol('skip');

async function pMap(iterable, mapper) {
  const results = [];
  let index = 0;
  for (const item of iterable) {
    results.push(await mapper(item, index++));
  }
  return results.filter((r) => r !== pMapSkip);
}

module.exports = pMap;
module.exports.default = pMap;
module.exports.pMapSkip = pMapSkip;
