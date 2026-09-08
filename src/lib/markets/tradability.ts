/**
 * Tradability-kapu — szabad-e MOST kereskedni egy instrumentummal.
 *
 * Ez a naptárt (`markets/calendar`) köti össze a katalógussal (`markets/registry`):
 * a kripto mindig kereskedhető; a részvény csak a szabályos ülésben. Zárt piacon az
 * instrumentum NEM tűnik el és NEM hiba — egyszerűen kimarad a döntésből egy látható
 * indokkal (a döntésnapló ezt rögzíti), pontosan úgy, ahogy egy HOLD.
 *
 * Tiszta függvények: az idő injektált, nincs IO.
 */

import { marketSession, type MarketSession } from "./calendar";
import { activeInstruments, type Instrument, type MarketEnv } from "./registry";

export interface InstrumentTradability {
  instrument: Instrument;
  session: MarketSession;
  /** Kereskedhető-e MOST (a session.open tükre, kényelmi mező). */
  tradable: boolean;
}

/** Egy instrumentum kereskedhetősége az adott időpontban. */
export function instrumentTradability(instrument: Instrument, nowMs: number): InstrumentTradability {
  const session = marketSession(instrument.assetClass, nowMs);
  return { instrument, session, tradable: session.open };
}

/** Az aktív univerzum kereskedhetőségi állapota — minden instrumentumra egy sor. */
export function tradabilitySnapshot(nowMs: number, env: MarketEnv = process.env): InstrumentTradability[] {
  return activeInstruments(env).map((inst) => instrumentTradability(inst, nowMs));
}

/** Csak a MOST kereskedhető instrumentumok (a döntési kör bemenete). */
export function tradableInstruments(nowMs: number, env: MarketEnv = process.env): Instrument[] {
  return tradabilitySnapshot(nowMs, env)
    .filter((t) => t.tradable)
    .map((t) => t.instrument);
}
