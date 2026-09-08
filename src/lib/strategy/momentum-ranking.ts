/**
 * Momentum-RANGSOROK — melyik jogosult papírba lépjünk be, ha több is kitörésben van.
 *
 * Miért külön modul: a belépő JOGOSULTSÁGA (kitörés-jel) és a KIVÁLASZTÁS két külön
 * kérdés. A mai kiválasztás a nyers periódus-változás maximuma. Négy papíron ez mindegy,
 * de a széles univerzumon a maximum SZISZTEMATIKUSAN a legvolatilisebb nevet hozza:
 * minél több papírt figyelünk, annál nagyobb a legnagyobb kilengés, és annál inkább a
 * csúcsra vásárlunk. A 2026-09-08-i szélesség-mérés (4 → 30 papír) pontosan ezt mutatta:
 * a szélesítés a hozamot rontotta, a maxDD-t négyszerezte.
 *
 * Ezért a rangsor itt CSERÉLHETŐ, ugyanúgy, ahogy a belépő-alak (`intraday-entries.ts`):
 * a `planStockCycle` opcionális rangsort kap, a backteszt pedig ugyanazon a végrehajtási
 * úton méri őket egymás ellen. Alapértelmezés a `raw` — az élő viselkedés nem változik.
 *
 * Minden rangsor TISZTA függvény: nincs IO, nincs `Date.now`, nincs állapot.
 */

/** Egy rangsorolandó jelölt. A hívó (planStockCycle) tölti ki a mezőket. */
export interface MomentumRankInput {
  symbol: string;
  /** A legutóbbi LEZÁRT periódus záró-változása százalékban (bar-hoz kötött, nem 24 óra). */
  change24hPct: number;
  /** ATR az utolsó záróár SZÁZALÉKÁBAN. Hiányzik, ha nincs elég adat a jelekhez. */
  atrPct?: number;
  /** A referencia-papír (SPY) ugyanazon periódusú változása százalékban, ha ismert. */
  benchmarkChangePct?: number;
}

/** Egy rangsor: magasabb pontszám = előbbre sorolt. `-Infinity` = nem rangsorolható. */
export type MomentumRanker = (input: MomentumRankInput) => number;

/**
 * A MAI rangsor: nyers százalékos változás. Referencia-pont a mérésekhez — bármelyik
 * új rangsornak ezt kell megvernie, különben nincs miért váltani.
 */
export const rawRank: MomentumRanker = (c) => c.change24hPct;

/**
 * Kockázat-korrigált: a változás a papír SAJÁT volatilitásának egységében (change / ATR%).
 * Így egy nyugodt papír 3%-os kitörése többet ér, mint egy 8%-os napi ingású neven a 6% —
 * az utóbbi a saját zajszintjén belül van, tehát nem jel.
 *
 * ATR nélkül (`undefined` vagy 0) a jelölt NEM rangsorolható, és `-Infinity`-t kap.
 * Szándékosan NEM esik vissza nyers százalékra: a két mérték nagyságrendje más, a
 * keverésük némán mindig az ATR-telen jelöltet hozná ki győztesnek.
 */
export const riskAdjustedRank: MomentumRanker = (c) =>
  c.atrPct !== undefined && c.atrPct > 0 ? c.change24hPct / c.atrPct : Number.NEGATIVE_INFINITY;

/**
 * A kettő együtt: piac-korrigált változás a saját volatilitás egységében.
 *
 * ÖNMAGÁBAN a relatív erő (change − benchmark) NEM rangsor: a benchmark egy cikluson
 * belül MINDEN jelöltre ugyanaz, egy konstans eltolás pedig nem tud sorrendet változtatni.
 * A 2026-09-08-i mérés ezt sorról sorra visszaigazolta (a nyers és a relatív-erő rangsor
 * hozama, trade-száma, maxDD-je bitre azonos volt), ezért a névtárban nincs külön `rs`
 * bejegyzés. Jelentése csak OSZTVA van: a volatilitás egységében már számít, mennyi jött
 * a piac sodrásából.
 */
export const rsRiskAdjustedRank: MomentumRanker = (c) =>
  c.atrPct !== undefined && c.atrPct > 0
    ? (c.change24hPct - (c.benchmarkChangePct ?? 0)) / c.atrPct
    : Number.NEGATIVE_INFINITY;

/**
 * A mért rangsorok névtára.
 *
 * Az ÉLES ciklus a `STOCK_MOMENTUM_RANKING` környezeti változóval választ innen; ha nincs
 * beállítva, a `raw` dönt (változatlan viselkedés). Ismeretlen névre a
 * `resolveMomentumRanking` null-t ad és a hívó naplóz — némán NEM vált rangsort.
 */
export const MOMENTUM_RANKINGS: Record<string, MomentumRanker> = {
  raw: rawRank,
  "risk-adjusted": riskAdjustedRank,
  "rs-risk-adjusted": rsRiskAdjustedRank,
};

/** Név → rangsor feloldás. Üres vagy ismeretlen névre null. */
export function resolveMomentumRanking(name: string): MomentumRanker | null {
  return MOMENTUM_RANKINGS[name.trim()] ?? null;
}
