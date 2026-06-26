/**
 * Trailing stop-loss (görgő stop) — tiszta függvény.
 * A stop csak felfelé kúszhat (ratchet), sosem csökken, így védi a már
 * megszerzett nyereséget egy emelkedő trendben.
 *
 * Lásd: profit-cycle spec kiegészítés (trailing stop, §B).
 * Nincs DB, nincs hálózat — determinisztikus, DB nélkül tesztelhető.
 */

/**
 * Kiszámolja az új stop-árt az árazás és a trail-távolság alapján.
 * Ha az aktuális ár magasabb (és így currentPrice*(1-stopLossPct) is magasabb a
 * korábbi stopnál), a stop felljebb lép. Ha az ár esett, a stop változatlan marad —
 * sosem csökken.
 *
 * @param currentStop   az eddigi (legmagasabb) stop-ár
 * @param currentPrice  az aktuális piaci ár
 * @param stopLossPct   trail-távolság a tőke hányadaként (pl. 0.05 = 5%)
 * @returns             az új stop-ár (≥ currentStop mindig)
 */
export function ratchetStop(
  currentStop: number,
  currentPrice: number,
  stopLossPct: number,
): number {
  // A lehetséges új stop = az aktuális ár trail-távolsággal lejjebb.
  const candidateStop = currentPrice * (1 - stopLossPct);
  // Csak felfelé kúszik: a nagyobbik (régi vagy új) érvényes.
  return Math.max(currentStop, candidateStop);
}
