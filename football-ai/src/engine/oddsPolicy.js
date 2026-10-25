// Politique centralisée : une cote ne devient une cote de coupon que si sa source est vérifiable.
// Les marketOdd/fairOdd calculées par le modèle restent des estimations et ne sont jamais acceptées.
export const REAL_ODD_SOURCES = Object.freeze(["feed", "manual", "screenshot"]);

export function isRealOdd(value) {
  const odd = typeof value === "number" ? value : Number(value);
  return Number.isFinite(odd) && odd > 1.01;
}

export function hasRealOdd(selectedMarket) {
  return Boolean(
    selectedMarket &&
      isRealOdd(selectedMarket.bookOdd) &&
      REAL_ODD_SOURCES.includes(selectedMarket.oddSource)
  );
}

export function realOddDetailsOf(prediction, market) {
  if (!Array.isArray(prediction?.valueAnalysis?.items) || !market || market.group !== "1X2") {
    return null;
  }
  const item = prediction.valueAnalysis.items.find((candidate) => candidate?.code === market.code);
  if (!item || !hasRealOdd(item)) return null;
  return item;
}

export function realOddOf(prediction, market) {
  const item = realOddDetailsOf(prediction, market);
  return item ? Number(item.bookOdd) : null;
}

export function legEdgePct(prediction, market) {
  const item = realOddDetailsOf(prediction, market);
  return item && Number.isFinite(item.evPct) ? item.evPct : null;
}
