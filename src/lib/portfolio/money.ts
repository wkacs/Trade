/**
 * Pénzügyi decimális aritmetika — EGY közös megoldás az egész rendszerre (T02/T04).
 *
 * Miért nem `number`? A JS double 0,1 + 0,2 ≠ 0,3 hibája egy fill-ledgerben halmozódik,
 * és az exchangeInfo szerinti kerekítéshez (stepSize/tickSize) amúgy is decimális
 * pontosság kell. Külső függőség helyett BigInt fixpontos aritmetika: nincs új csomag,
 * determinisztikus, és a DB `numeric` oszlopával ugyanaz a szöveges alak megy oda-vissza.
 *
 * REPREZENTÁCIÓ
 *  - A típus `Dec` = kanonikus decimális SZÖVEG (pl. "0.1", "-2.5", "0").
 *  - Belül minden érték egész szám `SCALE` (18) tizedesjegyre skálázva (bigint).
 *  - 18 tizedes bőven fedi a kripto mennyiségeket (a Binance stepSize legfeljebb 8) és
 *    az USD-összegeket. A 18 jegyen TÚLI bemenet elutasításra kerül — nem csendes csonkolás.
 *
 * KEREKÍTÉS (dokumentált, egységes)
 *  - add/sub: pontos, nincs kerekítés.
 *  - mul/div: az eredmény 18 tizedesre `half-up` (a 0,5 a nullától elfelé) kerekítve.
 *  - A megjelenítéshez/tőzsdei kerekítéshez explicit `round(value, decimals, mode)` van,
 *    ahol a mód kötelezően megadandó ("floor" | "ceil" | "half-up"). Nincs rejtett default.
 */

/** Kanonikus decimális szám szöveges alakban. */
export type Dec = string;

export const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Elfogadott bemeneti alak: opcionális előjel, egész rész, opcionális tizedes rész. */
const DECIMAL_RE = /^[+-]?(\d+)(\.\d+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Igaz, ha a szöveg érvényes decimális szám (nem NaN/Infinity/exponenciális/üres). */
export function isDecimalString(value: unknown): value is Dec {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s === "" || !DECIMAL_RE.test(s)) return false;
  const frac = s.split(".")[1];
  return frac === undefined || frac.length <= SCALE;
}

/** Szöveg → belső skálázott bigint. Hibás bemenetre DOB (nem 0-ra esik vissza). */
export function toUnits(value: Dec): bigint {
  if (!isDecimalString(value)) {
    throw new MoneyError(`Érvénytelen decimális érték: ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  const neg = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(SCALE)).slice(0, SCALE);
  const units = BigInt(intPart) * SCALE_FACTOR + BigInt(frac);
  return neg ? -units : units;
}

/** Belső skálázott bigint → kanonikus decimális szöveg (felesleges nullák nélkül). */
export function fromUnits(units: bigint): Dec {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const intPart = abs / SCALE_FACTOR;
  const fracPart = abs % SCALE_FACTOR;
  let frac = fracPart.toString().padStart(SCALE, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${intPart}.${frac}` : intPart.toString();
  // A "-0" nem kanonikus.
  return neg && abs !== 0n ? `-${body}` : body;
}

/**
 * Tetszőleges bemenet (szám vagy szöveg) → Dec. A `number` bemenet a JS pontossági
 * korlátai miatt csak KOMPATIBILITÁSI út (régi kód, külső API), és a 17 értékes jegyen
 * túl csonkolhat — új kódban Dec szöveget használj.
 */
export function dec(value: Dec | number): Dec {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyError(`Nem véges szám: ${value}`);
    // A String() a LEGRÖVIDEBB oda-vissza pontos alakot adja: 0.05 → "0.05".
    // A toFixed(18) ezzel szemben kiírná a bináris maradékot is
    // ("0.050000000000000003"), ami minden későbbi szorzásba beszivárogna.
    const s = String(value);
    return fromUnits(toUnits(/[eE]/.test(s) ? expandExponential(s) : s));
  }
  return fromUnits(toUnits(value));
}

/** Exponenciális alak (1e-7, 2.5e+3) feloldása sima decimális szöveggé. */
function expandExponential(input: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(input);
  if (!m) throw new MoneyError(`Nem értelmezhető exponenciális szám: ${input}`);
  const [, sign, intPart, fracPart = "", expStr] = m;
  const exp = Number(expStr);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  let body: string;
  if (pointPos <= 0) body = `0.${"0".repeat(-pointPos)}${digits}`;
  else if (pointPos >= digits.length) body = digits + "0".repeat(pointPos - digits.length);
  else body = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  const normalized = body.includes(".") ? body.replace(/0+$/, "").replace(/\.$/, "") : body;
  if (!isDecimalString(normalized)) {
    throw new MoneyError(`Az exponenciális szám nem fér a ${SCALE} tizedes pontosságba: ${input}`);
  }
  return sign === "-" ? `-${normalized}` : normalized;
}

/** Dec → number. CSAK megjelenítéshez/régi API-hoz; könyvelésre sosem. */
export function toNumber(value: Dec): number {
  return Number(value);
}

export const ZERO: Dec = "0";

export const add = (a: Dec, b: Dec): Dec => fromUnits(toUnits(a) + toUnits(b));
export const sub = (a: Dec, b: Dec): Dec => fromUnits(toUnits(a) - toUnits(b));

/** Előjel-helyes half-up osztás bigint-en (a 0,5 a nullától elfelé kerekít). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("Nullával osztás");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export const mul = (a: Dec, b: Dec): Dec =>
  fromUnits(divRoundHalfUp(toUnits(a) * toUnits(b), SCALE_FACTOR));

export const div = (a: Dec, b: Dec): Dec => {
  const db = toUnits(b);
  if (db === 0n) throw new MoneyError("Nullával osztás");
  return fromUnits(divRoundHalfUp(toUnits(a) * SCALE_FACTOR, db));
};

export const cmp = (a: Dec, b: Dec): -1 | 0 | 1 => {
  const ua = toUnits(a);
  const ub = toUnits(b);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
};

export const eq = (a: Dec, b: Dec): boolean => cmp(a, b) === 0;
export const lt = (a: Dec, b: Dec): boolean => cmp(a, b) < 0;
export const lte = (a: Dec, b: Dec): boolean => cmp(a, b) <= 0;
export const gt = (a: Dec, b: Dec): boolean => cmp(a, b) > 0;
export const gte = (a: Dec, b: Dec): boolean => cmp(a, b) >= 0;
export const isZero = (a: Dec): boolean => toUnits(a) === 0n;
export const isNegative = (a: Dec): boolean => toUnits(a) < 0n;
export const isPositive = (a: Dec): boolean => toUnits(a) > 0n;
export const neg = (a: Dec): Dec => fromUnits(-toUnits(a));
export const abs = (a: Dec): Dec => fromUnits(toUnits(a) < 0n ? -toUnits(a) : toUnits(a));
export const min = (a: Dec, b: Dec): Dec => (lte(a, b) ? dec(a) : dec(b));
export const max = (a: Dec, b: Dec): Dec => (gte(a, b) ? dec(a) : dec(b));

/** Összegzés — üres listára "0". */
export const sum = (values: Dec[]): Dec => values.reduce((s, v) => add(s, v), ZERO);

export type RoundMode = "floor" | "ceil" | "half-up";

/**
 * Kerekítés `decimals` tizedesjegyre. A mód KÖTELEZŐ — a hívó dönt, mert a tőzsdei
 * mennyiség lefelé (floor), a fedezet-igény felfelé (ceil), a megjelenítés half-up.
 * A floor/ceil a NULLA felé/től értendő matematikai értelemben (−1,5 floor → −2).
 */
export function round(value: Dec, decimals: number, mode: RoundMode): Dec {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > SCALE) {
    throw new MoneyError(`Érvénytelen tizedesjegy-szám: ${decimals}`);
  }
  const step = 10n ** BigInt(SCALE - decimals);
  const u = toUnits(value);
  if (step === 1n) return fromUnits(u);
  const q = u / step;
  const r = u % step;
  if (r === 0n) return fromUnits(q * step);
  let rounded: bigint;
  if (mode === "floor") rounded = u < 0n ? q - 1n : q;
  else if (mode === "ceil") rounded = u < 0n ? q : q + 1n;
  else {
    const absR = r < 0n ? -r : r;
    const bump = absR * 2n >= step ? 1n : 0n;
    rounded = u < 0n ? q - bump : q + bump;
  }
  return fromUnits(rounded * step);
}

/**
 * Lefelé kerekítés egy tetszőleges LÉPÉSKÖZRE (Binance LOT_SIZE stepSize / PRICE_FILTER
 * tickSize). A lépésköz maga is decimális szöveg. Negatív értékre hibát dob — mennyiség
 * és ár sosem negatív.
 */
export function floorToStep(value: Dec, step: Dec): Dec {
  const s = toUnits(step);
  if (s <= 0n) throw new MoneyError(`Érvénytelen lépésköz: ${step}`);
  const v = toUnits(value);
  if (v < 0n) throw new MoneyError(`Negatív érték nem kerekíthető lépésközre: ${value}`);
  return fromUnits((v / s) * s);
}
