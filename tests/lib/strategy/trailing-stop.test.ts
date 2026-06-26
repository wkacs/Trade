import { describe, it, expect } from "vitest";
import { ratchetStop } from "@/lib/strategy/trailing-stop";

/**
 * Trailing stop-loss (görgő stop) tiszta függvény tesztek.
 * A stop csak felfelé kúszhat, sosem csökken — így védi a már megszerzett nyereséget.
 * Lásd: profit-cycle spec kiegészítés (trailing stop), §B.
 */
describe("ratchetStop", () => {
  const stopLossPct = 0.05; // 5% — egyezik a RISK_LIMITS.stopLossPct-tal

  it("ár emelkedésekor a stop felljebb kúszik (5% az új ár alatt)", () => {
    const currentStop = 60000 * (1 - stopLossPct); // 57000
    const newPrice = 65000; // ár felment
    const result = ratchetStop(currentStop, newPrice, stopLossPct);
    // új stop = 65000 * 0.95 = 61750, ami > 57000 → ratchetel
    expect(result).toBeCloseTo(61750, 6);
    expect(result).toBeGreaterThan(currentStop);
  });

  it("ár stagnálása esetén a stop változatlan marad", () => {
    const currentStop = 60000 * (1 - stopLossPct); // 57000
    const samePrice = 60000; // ár nem mozdult
    const result = ratchetStop(currentStop, samePrice, stopLossPct);
    // új stop = 60000 * 0.95 = 57000 == currentStop → változatlan
    expect(result).toBe(currentStop);
  });

  it("ár esésekor a stop NEM csökken (megmarad a korábbi magasabb szint)", () => {
    const currentStop = 61750; // már ratcheteltük egy korábbi emelkedésnél
    const fallingPrice = 58000; // ár visszament, de még a stop felett
    const result = ratchetStop(currentStop, fallingPrice, stopLossPct);
    // új stop = 58000 * 0.95 = 55100, ami < 61750 → NEM csökken, a 61750 marad
    expect(result).toBe(currentStop);
    expect(result).toBeGreaterThan(55100);
  });

  it("sosem csökken soha — többszörös emelkedés/essés szekvencia", () => {
    // Indulás: 60000-es belépésnél stop = 57000
    let stop = 60000 * (1 - stopLossPct); // 57000
    // 1. emelkedés 64000-re
    stop = ratchetStop(stop, 64000, stopLossPct); // → 64000*0.95 = 60800
    expect(stop).toBeCloseTo(60800, 6);
    // 2. esés 60000-re (még a stop felett)
    stop = ratchetStop(stop, 60000, stopLossPct); // → max(60800, 57000) = 60800
    expect(stop).toBeCloseTo(60800, 6);
    // 3. újabb emelkedés 70000-re
    stop = ratchetStop(stop, 70000, stopLossPct); // → 70000*0.95 = 66500
    expect(stop).toBeCloseTo(66500, 6);
    // 4. nagy esés 65000-re
    stop = ratchetStop(stop, 65000, stopLossPct); // → max(66500, 61750) = 66500
    expect(stop).toBeCloseTo(66500, 6);
    // A stop sosem csökkent az indulási 57000 alá, és most 66500-on áll
    expect(stop).toBeGreaterThan(57000);
  });
});
