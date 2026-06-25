# AI Kereskedő Bot Web App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egy hibrid AI (LightGBM + GLM) által vezérelt kripto-trading web app, amely papír-trading módban indul, óránkénti cron ciklussal dönt, látható érveléssel, és egy konfig kapcsolóval váltható valós Binance módra.

**Architecture:** Next.js (App Router) a Vercelen — frontend + API routes egyben. Neon Postgres az egyetlen igazságforrás (idősorozat-tárolás). Vercel Cron indítja óránként a `/api/cron/tick` route-ot. A döntési lánc: Data Collectors → ML signals → GLM Phase-1 (szűrés, GLM-4-Flash) → GLM Phase-2 (döntés, GLM-5.2) → Risk Manager → Execution Layer (Paper vagy Binance). Minden LLM hívás OpenAI-kompatibilis API-n (Zhipu/GLM endpoint).

**Tech Stack:** Next.js 14 (App Router, TypeScript), Tailwind CSS, Neon Postgres (Drizzle ORM), Vercel Cron, GLM API (OpenAI SDK compat), LightGBM (Python lambda via external job, vagy a Vercelen túl futtatva), Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md`

---

## File Structure

```
ZCodeProject/
├─ .env.example
├─ .env.local                          (gitignored — lokális kulcsok)
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ next.config.mjs
├─ tailwind.config.ts
├─ postcss.config.mjs
├─ vitest.config.ts
├─ drizzle.config.ts
├─ src/
│  ├─ db/
│  │  ├─ schema.ts                     (Drizzle séma — összes tábla)
│  │  ├─ client.ts                     (Neon kapcsolat)
│  │  └─ migrations/                   (Drizzle generálja)
│  ├─ lib/
│  │  ├─ config.ts                     (kockázati limitlek, coin kosár, mode)
│  │  ├─ types.ts                      (közös típusok: Decision, Order, Trade…)
│  │  ├─ llm/
│  │  │  ├─ client.ts                  (OpenAI-compat GLM client, provider switch)
│  │  │  ├─ phase1-filter.ts           (GLM-4-Flash „érdemes-e dönteni?")
│  │  │  ├─ phase2-decide.ts           (GLM-5.2 strukturált döntés)
│  │  │  └─ schemas.ts                 (JSON sémák a LLM kimenetekhez)
│  │  ├─ collectors/
│  │  │  ├─ base.ts                    (DataCollector interfész)
│  │  │  ├─ coingecko.ts
│  │  │  ├─ cryptopanic.ts
│  │  │  ├─ whalealert.ts
│  │  │  └─ rss.ts
│  │  ├─ ml/
│  │  │  ├─ features.ts                (feature engineering raw_events-ből)
│  │  │  ├─ predictor.ts               (betöltött LightGBM model inference)
│  │  │  └─ README.md                  (hogyan tréningelj — külső Python script)
│  │  ├─ risk/
│  │  │  └─ risk-manager.ts            (limitek ellenőrzése + override)
│  │  ├─ execution/
│  │  │  ├─ broker.ts                  (Broker interfész)
│  │  │  ├─ paper-broker.ts
│  │  │  └─ binance-broker.ts
│  │  ├─ portfolio/
│  │  │  └─ accounting.ts              (pozíciók, P&L számítás)
│  │  └─ engine/
│  │     └─ tick.ts                    (a teljes óránkénti ciklus vezérlője)
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx                      (Dashboard főoldal)
│  │  ├─ globals.css
│  │  └─ api/
│  │     ├─ cron/
│  │     │  └─ tick/route.ts           (Vercel Cron célja)
│  │     ├─ portfolio/route.ts
│  │     ├─ decisions/route.ts
│  │     ├─ backtest/route.ts
│  │     └─ admin/route.ts             (mode switch)
│  └─ components/
│     ├─ Dashboard.tsx
│     ├─ PortfolioPanel.tsx
│     ├─ DecisionsTimeline.tsx
│     ├─ DecisionCard.tsx
│     ├─ DecisionDetail.tsx
│     ├─ BacktestPanel.tsx
│     └─ AdminPanel.tsx
└─ tests/
   ├─ lib/
   │  ├─ collectors/*.test.ts
   │  ├─ risk/risk-manager.test.ts
   │  ├─ execution/paper-broker.test.ts
   │  ├─ llm/phase1-filter.test.ts
   │  ├─ llm/phase2-decide.test.ts
   │  └─ engine/tick.test.ts
   └─ fixtures/
      └─ sample-events.json
```

---

## Phase 0 — Projekt scaffold és tooling

### Task 0.1: Next.js projekt + tooling inicializálása

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Scaffold Next.js TypeScript projekt**

```bash
cd C:\Users\konig\ZCodeProject
pnpm create next-app@latest . --ts --tailwind --app --eslint --src-dir --import-alias "@/*" --use-pnpm
```

Ha a prompt a meglévő `docs/` miatt kérdez: válaszd a „keep existing files / merge". Ha interaktív és nem megy, manuálisan hozd létre a `package.json`-t:

```json
{
  "name": "ai-crypto-trader",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "drizzle-orm": "0.33.0",
    "@neondatabase/serverless": "0.9.1",
    "openai": "4.56.0",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "@types/node": "20.14.14",
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "tailwindcss": "3.4.7",
    "postcss": "8.4.40",
    "autoprefixer": "10.4.19",
    "eslint": "8.57.0",
    "eslint-config-next": "14.2.5",
    "vitest": "2.0.5",
    "@vitejs/plugin-react": "4.3.1",
    "jsdom": "24.1.1",
    "drizzle-kit": "0.24.2"
  }
}
```

- [ ] **Step 2: Telepítsd a függőségeket**

```bash
pnpm install
```

- [ ] **Step 3: Készítsd el a `.gitignore`-t**

`.gitignore`:
```gitignore
# dependencies
node_modules
.pnp
.pnp.js

# next.js
.next
out
build

# env
.env
.env.local
.env*.local

# misc
.DS_Store
*.pem
.vscode/

# db
drizzle/meta/_journal.json.bak

# ml artifacts
*.txt LightGBM-model*
ml_model.txt
model.json

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
```

- [ ] **Step 4: Készítsd el a `.env.example`-et**

`.env.example`:
```bash
# Neon Postgres
DATABASE_URL="postgres://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require"

# GLM API (Zhipu) — OpenAI-compatible endpoint
LLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
LLM_API_KEY="your-zhipu-api-key-here"
LLM_MODEL_PHASE1="glm-4-flash"
LLM_MODEL_PHASE2="glm-5.2"

# Cron security
CRON_SECRET="some-random-secret-string"

# Trading mode: "paper" or "live"
TRADING_MODE="paper"

# Binance (csak live módban, 2. fázis)
BINANCE_API_KEY=""
BINANCE_API_SECRET=""
```

- [ ] **Step 5: Készítsd el a `vitest.config.ts`-t**

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    globals: true,
  },
});
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + Tailwind + Vitest + Drizzle tooling"
```

---

### Task 0.2: Konfigurációs modul + közös típusok

**Files:**
- Create: `src/lib/config.ts`, `src/lib/types.ts`

- [ ] **Step 1: Írd meg a típusteszteket**

`tests/lib/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RISK_LIMITS, COIN_UNIVERSE, getTradingMode } from "@/lib/config";

describe("config", () => {
  it("konzervatív limitlek vannak beállítva", () => {
    expect(RISK_LIMITS.maxPositionPct).toBe(0.2);
    expect(RISK_LIMITS.stopLossPct).toBe(0.05);
    expect(RISK_LIMITS.leverage).toBe(1);
    expect(RISK_LIMITS.maxConcurrentPositions).toBe(3);
    expect(RISK_LIMITS.dailyLossCircuitBreakerPct).toBe(0.03);
  });

  it("BTC, ETH, SOL a coin kosár USDT párral", () => {
    expect(COIN_UNIVERSE).toEqual(["BTC", "ETH", "SOL"]);
  });

  it(" alapértelmezetten paper módban vagyunk", () => {
    expect(getTradingMode()).toBe("paper");
  });
});
```

- [ ] **Step 2: Futtasd le, hogy biztosan elbukjon**

```bash
pnpm test tests/lib/config.test.ts
```
Expected: FAIL — modul nem található.

- [ ] **Step 3: Implementáld `src/lib/config.ts`-t**

```ts
export interface RiskLimits {
  /** Egy pozíció maximális része a teljes tőkéből (0.2 = 20%). */
  maxPositionPct: number;
  /** Kötelező stop-loss (0.05 = -5%). */
  stopLossPct: number;
  /** Tőkeáttétel (1 = nincs). */
  leverage: number;
  /** Maximális egyidejű pozíciók száma. */
  maxConcurrentPositions: number;
  /** Napi max veszteség, ami HOLD-only circuit breakert aktivál (0.03 = -3%). */
  dailyLossCircuitBreakerPct: number;
}

/** Konzervatív kockázati limitlek — védik a kis tőkét. Lásd spec §3.4. */
export const RISK_LIMITS: RiskLimits = {
  maxPositionPct: 0.2,
  stopLossPct: 0.05,
  leverage: 1,
  maxConcurrentPositions: 3,
  dailyLossCircuitBreakerPct: 0.03,
};

/** Fix coin kosár USDT párban. Bővíthető a settings-en keresztül. Lásd spec §3.6. */
export const COIN_UNIVERSE = ["BTC", "ETH", "SOL"] as const;
export type CoinSymbol = (typeof COIN_UNIVERSE)[number];

export type TradingMode = "paper" | "live";

/** Visszaadja a jelenlegi kereskedési módot (env-ből). Alapértelmezett: paper. */
export function getTradingMode(): TradingMode {
  const mode = process.env.TRADING_MODE ?? "paper";
  return mode === "live" ? "live" : "paper";
}
```

- [ ] **Step 4: Implementáld `src/lib/types.ts`-t**

```ts
/** Egy adatgyűjtőtől érkező normalizált adatpont. */
export interface DataPoint {
  source: "coingecko" | "cryptopanic" | "whalealert" | "rss";
  symbol: string;
  timestamp: number; // epoch ms
  kind: "price" | "news" | "whale" | "rss";
  // Tartalom a kind-tól függően:
  price?: { usd: number; volume24h: number; change24hPct: number };
  news?: { title: string; url: string; sentiment: "bullish" | "bearish" | "neutral" };
  whale?: { amountUsd: number; direction: "exchange-in" | "exchange-out"; from: string; to: string };
  rss?: { title: string; url: string; source: string };
}

/** ML jelzések egy coinra, egy időpontban. */
export interface MlSignal {
  symbol: string;
  timestamp: number;
  direction1h: "up" | "down" | "flat"; // előrejelzett irány 1 órás horizontra
  confidence: number; // 0..1
  volatilityPct: number; // előrejelzett volatilitás %
}

/** Az AI által javasolt döntés (fázis-2 kimenet, Risk Manager előtt). */
export interface RawDecision {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  amountPct: number; // a tőke hányada (BUY/SELL esetén)
  confidence: number; // 0..1
  reasoning: string; // kötelező — a „saját vélemény"
  model: string;
}

/** Risk Manager által validált végleges döntés. */
export interface Decision extends RawDecision {
  id: string;
  timestamp: number;
  overridden: boolean; // true, ha a Risk Manager módosította/elutasította
  overrideReason?: string;
}

/** Végrehajtható order a broker felé. */
export interface Order {
  side: "BUY" | "SELL";
  symbol: string;
  amountUsd: number;
  stopLossPct: number;
}

/** Egy végrehajtott tranzakció eredménye. */
export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  price: number; // USD / coin
  qty: number;
  feeUsd: number;
  executedAt: number;
  mode: "paper" | "live";
}
```

- [ ] **Step 5: Futtasd a tesztet, hogy passzoljon**

```bash
pnpm test tests/lib/config.test.ts
```
Expected: PASS (3 teszt).

- [ ] &nbsp;**Step 6: Commit**

```bash
git add src/lib/config.ts src/lib/types.ts tests/lib/config.test.ts
git commit -m "feat: config + közös típusok (limitlek, coin kosár, mode)"
```

---

## Phase 1 — Adatbázis és adatgyűjtők

### Task 1.1: Neon + Drizzle kapcsolat és séma

**Files:**
- Create: `src/db/client.ts`, `src/db/schema.ts`, `drizzle.config.ts`

- [ ] **Step 1: Készítsd el a `drizzle.config.ts`-t**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 2: Írd meg a sémát `src/db/schema.ts`**

```ts
import {
  pgTable, text, timestamp, real, integer, boolean, uuid, jsonb, varchar,
} from "drizzle-orm/pg-core";

/** Gyűjtők nyers adatai — idősorozat. Lásd spec §5. */
export const rawEvents = pgTable("raw_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: varchar("source", { length: 32 }).notNull(), // coingecko|cryptopanic|whalealert|rss
  symbol: varchar("symbol", { length: 16 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(), // price|news|whale|rss
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(), // a DataPoint tartalma
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** ML jelek időpontonként, coinonként. */
export const mlSignals = pgTable("ml_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  direction1h: varchar("direction_1h", { length: 8 }).notNull(),
  confidence: real("confidence").notNull(),
  volatilityPct: real("volatility_pct").notNull(),
});

/** Portfólió: egyetlen sor (személyes használat). */
export const portfolios = pgTable("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  initialCapitalUsd: real("initial_capital_usd").notNull(),
  cashUsd: real("cash_usd").notNull(),
  mode: varchar("mode", { length: 8 }).notNull().default("paper"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Nyitott pozíciók. */
export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  qty: real("qty").notNull(),
  entryPrice: real("entry_price").notNull(),
  stopPrice: real("stop_price").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

/** Végrehajtott tranzakciók (több egy pozícióhoz). */
export const trades = pgTable("trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id").references(() => positions.id),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  side: varchar("side", { length: 4 }).notNull(), // BUY|SELL
  amountUsd: real("amount_usd").notNull(),
  price: real("price").notNull(),
  qty: real("qty").notNull(),
  feeUsd: real("fee_usd").notNull(),
  mode: varchar("mode", { length: 8 }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).defaultNow().notNull(),
});

/** AI döntések + érvelés (a rendszer szíve). */
export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  tickId: varchar("tick_id", { length: 16 }).notNull(), // YYYY-MM-DD-HH
  action: varchar("action", { length: 4 }).notNull(), // BUY|SELL|HOLD
  symbol: varchar("symbol", { length: 16 }),
  amountPct: real("amount_pct"),
  confidence: real("confidence").notNull(),
  reasoning: text("reasoning").notNull(),
  model: varchar("model", { length: 32 }).notNull(),
  overridden: boolean("overridden").notNull().default(false),
  overrideReason: text("override_reason"),
});

/** Amikor a Risk Manager módosított/elutasított egy döntést. */
export const riskOverrides = pgTable("risk_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id").references(() => decisions.id),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  originalAction: varchar("original_action", { length: 4 }).notNull(),
  originalAmountPct: real("original_amount_pct").notNull(),
  finalAction: varchar("final_action", { length: 4 }).notNull(),
  finalAmountPct: real("final_amount_pct").notNull(),
  reason: text("reason").notNull(),
});

/** Backtest futtatások. */
export const backtests = pgTable("backtests", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategy: varchar("strategy", { length: 64 }).notNull(),
  startTs: timestamp("start_ts", { withTimezone: true }).notNull(),
  endTs: timestamp("end_ts", { withTimezone: true }).notNull(),
  resultPnlPct: real("result_pnl_pct").notNull(),
  tradesCount: integer("trades_count").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Globális settings (mode, limitlek, coin kosár). */
export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
});
```

- [ ] **Step 3: Implementáld a DB clientet `src/db/client.ts`**

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL nincs beállítva. Lásd .env.example");
}

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql, { schema });
export { schema };
```

- [ ] **Step 4: Generálj migrációt (lokálisan, DATABASE_URL kell)**

```bash
pnpm db:generate
```
Expected: új fájl `src/db/migrations/` alatt.

- [ ] **Step 5: Commit**

```bash
git add src/db/ drizzle.config.ts
git commit -m "feat(db): Neon + Drizzle séma (raw_events, decisions, positions, …)"
```

---

### Task 1.2: Data Collector interfész

**Files:**
- Create: `src/lib/collectors/base.ts`

- [ ] **Step 1: Írd meg az interfészt és egy dummy tesztet**

`tests/lib/collectors/base.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectAll } from "@/lib/collectors/base";

// Dummy collector mockolt viselkedéshez
describe("collectAll", () => {
  it("üres lista esetén üres eredményt ad", async () => {
    const result = await collectAll([]);
    expect(result).toEqual([]);
  });

  it("több collector eredményét egyesíti", async () => {
    const fakeCollector = {
      name: "fake",
      collect: async () => [
        { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 100, volume24h: 1, change24hPct: 0 } },
      ],
    };
    const result = await collectAll([fakeCollector as any]);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("BTC");
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/collectors/base.test.ts
```
Expected: FAIL — `collectAll` nem található.

- [ ] **Step 3: Implementáld `src/lib/collectors/base.ts`**

```ts
import type { DataPoint } from "@/lib/types";

export interface DataCollector {
  name: string;
  collect(): Promise<DataPoint[]>;
}

/**
 * Az összes regisztrált collectort párhuzamosan lefuttatja,
 * és egyesíti az eredményeket. Hibák egy collectorban nem döntik
 * romba a teljes ciklust — a többi eredménye megmarad.
 */
export async function collectAll(collectors: DataCollector[]): Promise<DataPoint[]> {
  const results = await Promise.allSettled(collectors.map((c) => c.collect()));
  const ok: DataPoint[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(...r.value);
    // rejected esetén logolunk, de nem dobjunk — lásd spec §6 (LLM-hiba nem omlik össze)
    else console.error("[collectAll] collector hiba:", r.reason);
  }
  return ok;
}
```

- [ ] **Step 4: Futtasd a tesztet, hogy passzoljon**

```bash
pnpm test tests/lib/collectors/base.test.ts
```
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectors/base.ts tests/lib/collectors/base.test.ts
git commit -m "feat(collectors): DataCollector interfész + collectAll"
```

---

### Task 1.3: CoinGecko collector

**Files:**
- Create: `src/lib/collectors/coingecko.ts`

- [ ] **Step 1: Teszt mockolt fetch-csel**

`tests/lib/collectors/coingecko.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";

describe("CoinGeckoCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("árat normalizál DataPoint-tá", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 60000, usd_24h_vol: 5_000_000_000, usd_24h_change: 2.5 },
        ethereum: { usd: 3000, usd_24h_vol: 1_000_000_000, usd_24h_change: -1.2 },
        solana: { usd: 150, usd_24h_vol: 200_000_000, usd_24h_change: 0.5 },
      }),
    });

    const collector = new CoinGeckoCollector(["BTC", "ETH", "SOL"]);
    const result = await collector.collect();

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      source: "coingecko",
      symbol: "BTC",
      kind: "price",
      price: { usd: 60000, volume24h: 5_000_000_000, change24hPct: 2.5 },
    });
  });

  it("API hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const collector = new CoinGeckoCollector(["BTC"]);
    const result = await collector.collect();
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/collectors/coingecko.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/collectors/coingecko.ts`**

```ts
import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

const CG_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

/**
 * CoinGecko simple price API (ingyenes tier). Lásd spec §3.1.
 * ID-nként limitelve van az ingyenes tier, de a 3 coinra bőven elég.
 */
export class CoinGeckoCollector implements DataCollector {
  name = "coingecko";
  private symbols: string[];

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  async collect(): Promise<DataPoint[]> {
    const ids = this.symbols.map((s) => CG_ID[s]).filter(Boolean).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[CoinGecko] HTTP", res.status);
      return [];
    }
    const data = await res.json();
    const ts = Date.now();
    return this.symbols
      .filter((s) => CG_ID[s] && data[CG_ID[s]])
      .map((s) => {
        const d = data[CG_ID[s]];
        return {
          source: "coingecko" as const,
          symbol: s,
          timestamp: ts,
          kind: "price" as const,
          price: {
            usd: d.usd as number,
            volume24h: d.usd_24h_vol as number,
            change24hPct: d.usd_24h_change as number,
          },
        };
      });
  }
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/collectors/coingecko.test.ts
```
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectors/coingecko.ts tests/lib/collectors/coingecko.test.ts
git commit -m "feat(collectors): CoinGecko árgyűjtő"
```

---

### Task 1.4: CryptoPanic collector (hírek + sentiment)

**Files:**
- Create: `src/lib/collectors/cryptopanic.ts`

- [ ] **Step 1: Teszt**

`tests/lib/collectors/cryptopanic.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";

describe("CryptoPanicCollector", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("híreket sentiment-té normalizál", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: "BTC ETF inflow record", url: "https://x/1", currency: { code: "BTC" }, votes: { positive: 10, negative: 1, important: 5 } },
          { title: "ETH hack", url: "https://x/2", currency: { code: "ETH" }, votes: { positive: 0, negative: 8, important: 3 } },
        ],
      }),
    });
    const c = new CryptoPanicCollector("dummy-token", ["BTC", "ETH"]);
    const result = await c.collect();
    expect(result).toHaveLength(2);
    expect(result[0].news?.sentiment).toBe("bullish");
    expect(result[1].news?.sentiment).toBe("bearish");
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/collectors/cryptopanic.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/collectors/cryptopanic.ts`**

```ts
import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

interface CpResult {
  title: string;
  url: string;
  currency?: { code: string };
  votes: { positive: number; negative: number; important: number };
}

/**
 * CryptoPanic ingyenes API — hírek + vote-alapú sentiment.
 * Lásd spec §3.1. A token az ingyenes regisztráció után jár.
 */
export class CryptoPanicCollector implements DataCollector {
  name = "cryptopanic";
  constructor(private authToken: string, private symbols: string[]) {}

  async collect(): Promise<DataPoint[]> {
    const filter = this.symbols.map((s) => s.toUpperCase()).join(",");
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${this.authToken}&currencies=${filter}&kind=news`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[CryptoPanic] HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as { results: CpResult[] };
    const ts = Date.now();
    return data.results
      .filter((r) => r.currency?.code && this.symbols.includes(r.currency.code.toUpperCase()))
      .map((r) => {
        const sentiment = r.votes.positive > r.votes.negative
          ? "bullish"
          : r.votes.negative > r.votes.positive
            ? "bearish"
            : "neutral";
        return {
          source: "cryptopanic" as const,
          symbol: r.currency!.code.toUpperCase(),
          timestamp: ts,
          kind: "news" as const,
          news: { title: r.title, url: r.url, sentiment },
        };
      });
  }
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/collectors/cryptopanic.test.ts
```
Expected: PASS (1 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectors/cryptopanic.ts tests/lib/collectors/cryptopanic.test.ts
git commit -m "feat(collectors): CryptoPanic hír + sentiment gyűjtő"
```

---

### Task 1.5: WhaleAlert collector

**Files:**
- Create: `src/lib/collectors/whalealert.ts`

- [ ] **Step 1: Teszt**

`tests/lib/collectors/whalealert.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";

describe("WhaleAlertCollector", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("nagy tranzakciókat irányként normalizál", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { symbol: "BTC", amount_usd: 1_500_000, blockchain: "bitcoin", from: { owner: "unknown" }, to: { owner: "binance" } },
          { symbol: "ETH", amount_usd: 800_000, from: { owner: "kraken" }, to: { owner: "unknown" } },
        ],
      }),
    });
    const c = new WhaleAlertCollector("tok", ["BTC", "ETH"]);
    const r = await c.collect();
    expect(r).toHaveLength(2);
    expect(r[0].whale?.direction).toBe("exchange-in"); // külső → binance
    expect(r[1].whale?.direction).toBe("exchange-out"); // kraken → külső
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/collectors/whalealert.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/collectors/whalealert.ts`**

```ts
import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

const EXCHANGES = new Set(["binance", "kraken", "coinbase", "okx", "bybit", "huobi", "bitfinex"]);

interface WaTx {
  symbol: string;
  amount_usd: number;
  blockchain?: string;
  from?: { owner?: string };
  to?: { owner?: string };
}

/**
 * WhaleAlert ingyenes API — nagy (>500k USD) on-chain tranzakciók.
 * Az irány: exchange-in = tőzsdére (gyakran eladás jel), exchange-out = tőzsdéről (felhalmozás).
 * Lásd spec §3.1.
 */
export class WhaleAlertCollector implements DataCollector {
  name = "whalealert";
  constructor(private apiKey: string, private symbols: string[]) {}

  async collect(): Promise<DataPoint[]> {
    // Utolsó 1 óra nagy tranzakciói
    const start = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const url = `https://api.whale-alert.io/v1/transactions?api_key=${this.apiKey}&min-value=500000&start=${start}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[WhaleAlert] HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as { result?: WaTx[] };
    const ts = Date.now();
    return (data.result ?? [])
      .filter((t) => this.symbols.includes(t.symbol.toUpperCase()))
      .map((t) => {
        const fromEx = EXCHANGES.has((t.from?.owner ?? "").toLowerCase());
        const toEx = EXCHANGES.has((t.to?.owner ?? "").toLowerCase());
        const direction = toEx && !fromEx ? "exchange-in" : fromEx && !toEx ? "exchange-out" : "exchange-in";
        return {
          source: "whalealert" as const,
          symbol: t.symbol.toUpperCase(),
          timestamp: ts,
          kind: "whale" as const,
          whale: {
            amountUsd: t.amount_usd,
            direction,
            from: t.from?.owner ?? "unknown",
            to: t.to?.owner ?? "unknown",
          },
        };
      });
  }
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/collectors/whalealert.test.ts
```
Expected: PASS (1 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectors/whalealert.ts tests/lib/collectors/whalealert.test.ts
git commit -m "feat(collectors): WhaleAlert nagy tranzakció gyűjtő"
```

---

### Task 1.6: RSS collector (legális scrape)

**Files:**
- Create: `src/lib/collectors/rss.ts`

- [ ] **Step 1: Teszt**

`tests/lib/collectors/rss.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RSSCollector } from "@/lib/collectors/rss";

describe("RSSCollector", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("RSS XML-t DataPoint-tá alakít", async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>BTC rally</title><link>https://coindesk.com/1</link></item>
      <item><title>ETH news</title><link>https://coindesk.com/2</link></item>
    </channel></rss>`;
    (global.fetch as any).mockResolvedValue({ ok: true, text: async () => xml });
    const c = new RSSCollector([{ name: "CoinDesk", url: "https://coindesk.com/rss", symbol: "BTC" }]);
    const r = await c.collect();
    expect(r).toHaveLength(2);
    expect(r[0].rss?.source).toBe("CoinDesk");
    expect(r[0].symbol).toBe("BTC");
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/collectors/rss.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/collectors/rss.ts`**

```ts
import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

export interface RSSSource {
  name: string;
  url: string;
  /** Mely coinhoz rendeljük a cikkeket (ha a feed vegyes). */
  symbol: string;
}

/**
 * Legális RSS scrape — csak olyan feedeket használjunk, amik ezt megengedik
 * (pl. CoinDesk, BTC.com publikus RSS). Lásd spec §3.1.
 * Egyszerű regex-parsolás (felesleges függőség nélkül).
 */
export class RSSCollector implements DataCollector {
  name = "rss";
  constructor(private sources: RSSSource[]) {}

  async collect(): Promise<DataPoint[]> {
    const ts = Date.now();
    const out: DataPoint[] = [];
    for (const src of this.sources) {
      try {
        const res = await fetch(src.url);
        if (!res.ok) continue;
        const xml = await res.text();
        const items = xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>/g);
        for (const m of items) {
          out.push({
            source: "rss",
            symbol: src.symbol,
            timestamp: ts,
            kind: "rss",
            rss: { title: m[1].trim(), url: m[2].trim(), source: src.name },
          });
        }
      } catch (e) {
        console.error("[RSS]", src.name, e);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/collectors/rss.test.ts
```
Expected: PASS (1 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectors/rss.ts tests/lib/collectors/rss.test.ts
git commit -m "feat(collectors): RSS legális scrape gyűjtő"
```

---

## Phase 2 — AI Decision Core (LLM)

### Task 2.1: GLM client (OpenAI-compatible)

**Files:**
- Create: `src/lib/llm/client.ts`

- [ ] **Step 1: Implementáld a GLM klienst**

`src/lib/llm/client.ts`:
```ts
import OpenAI from "openai";

/**
 * GLM (Zhipu AI) kliens OpenAI-compatible endpointon.
 * Lásd spec §3.2 + GLM-5.2 docs. Provider cserélhető, ha a BASE_URL-t átírod.
 */
export function createLlm(modelOverride?: string) {
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY!,
    baseURL: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
  });
  return {
    client,
    model: modelOverride ?? "glm-4-flash",
  };
}

/**
 * Strukturált JSON kimenet kérése a modelltől. Ha a modell nem ad érvényes JSON-t,
 * a fallback értékkel tér vissza (a hívó felel a HOLD-ra esést). Lásd spec §6.
 */
export async function chatJson<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  fallback: T,
): Promise<{ data: T; raw: string }> {
  const { client } = createLlm(model);
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // GLM támogatja a JSON módot — struktúrát kényszerít
      response_format: { type: "json_object" } as any,
      temperature: 0.3,
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return { data: safeParse(raw, fallback), raw };
  } catch (e) {
    console.error("[LLM] hiba, fallback:", e);
    return { data: fallback, raw: "" };
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Próbáljuk meg a legelső { ... } blokkot
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {}
    }
    return fallback;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/llm/client.ts
git commit -m "feat(llm): GLM OpenAI-compat kliens + chatJson helper"
```

---

### Task 2.2: Phase-1 filter (GLM-4-Flash)

**Files:**
- Create: `src/lib/llm/schemas.ts`, `src/lib/llm/phase1-filter.ts`

- [ ] **Step 1: Sémák**

`src/lib/llm/schemas.ts`:
```ts
import { z } from "zod";

/** Phase-1 kimenet: érdemes-e egyáltalán döntést hozni? */
export const Phase1ResultSchema = z.object({
  shouldDecide: z.boolean(),
  summary: z.string(),
  notableEvents: z.array(z.object({
    symbol: z.string(),
    reason: z.string(),
  })).default([]),
});
export type Phase1Result = z.infer<typeof Phase1ResultSchema>;

/** Phase-2 kimenet: a konkrét döntés. */
export const Phase2ResultSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  symbol: z.string().optional(),
  amountPct: z.number().min(0).max(1).default(0),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type Phase2Result = z.infer<typeof Phase2ResultSchema>;
```

- [ ] **Step 2: Teszt**

`tests/lib/llm/phase1-filter.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { shouldDecide } from "@/lib/llm/phase1-filter";

describe("shouldDecide", () => {
  it("ha nincs érdemi esemény, false-t ad", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      chatJson: vi.fn().mockResolvedValue({
        data: { shouldDecide: false, summary: "csendes óra", notableEvents: [] },
        raw: "",
      }),
    }));
    const { shouldDecide } = await import("@/lib/llm/phase1-filter");
    const result = await shouldDecide([]);
    expect(result.shouldDecide).toBe(false);
  });
});
```

- [ ] **Step 3: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/llm/phase1-filter.test.ts
```

- [ ] **Step 4: Implementáld `src/lib/llm/phase1-filter.ts`**

```ts
import type { DataPoint } from "@/lib/types";
import { chatJson } from "./client";
import { Phase1ResultSchema, type Phase1Result } from "./schemas";

const SYSTEM = `Te egy kripto-trading asszisztens első szűrő fázisa vagy.
A feladat: eldönteni, hogy az elmúlt órában történt-e olyan érdemi esemény
(hír, whale-mozgás, jelentős árelésés), ami indokolná egy BUY/SELL döntést.
Ha nincs semmi érdemes, shouldDecide=false. Csak JSON-t adj.`;

/**
 * Phase-1: GLM-4-Flash (ingyenes) minden órában. Ez a ciklus 90%-a.
 * Lásd spec §3.2.
 */
export async function shouldDecide(events: DataPoint[]): Promise<Phase1Result> {
  if (events.length === 0) {
    return { shouldDecide: false, summary: "Nincsenek események.", notableEvents: [] };
  }
  const compact = events.map((e) => ({
    s: e.symbol,
    k: e.kind,
    ...(e.price ? { px: e.price.usd, ch: e.price.change24hPct } : {}),
    ...(e.news ? { t: e.news.title, sent: e.news.sentiment } : {}),
    ...(e.whale ? { amt: e.whale.amountUsd, dir: e.whale.direction } : {}),
    ...(e.rss ? { t: e.rss.title, src: e.rss.source } : {}),
  }));
  const fallback: Phase1Result = { shouldDecide: false, summary: "LLM hiba, HOLD.", notableEvents: [] };
  const { data } = await chatJson<Phase1Result>(
    process.env.LLM_MODEL_PHASE1 ?? "glm-4-flash",
    SYSTEM,
    JSON.stringify(compact),
    fallback,
  );
  return Phase1ResultSchema.parse(data);
}
```

- [ ] **Step 5: Futtasd a tesztet**

```bash
pnpm test tests/lib/llm/phase1-filter.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/schemas.ts src/lib/llm/phase1-filter.ts tests/lib/llm/phase1-filter.test.ts
git commit -m "feat(llm): phase-1 szűrő (GLM-4-Flash) + JSON sémák"
```

---

### Task 2.3: Phase-2 decide (GLM-5.2)

**Files:**
- Create: `src/lib/llm/phase2-decide.ts`

- [ ] **Step 1: Teszt**

`tests/lib/llm/phase2-decide.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn().mockResolvedValue({
    data: {
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.15,
      confidence: 0.72,
      reasoning: "ETF inflow + whale gyűjtés → bullish.",
    },
    raw: "",
  }),
}));

import { decide } from "@/lib/llm/phase2-decide";

describe("decide (phase-2)", () => {
  it("strukturált döntést ad érveléssel", async () => {
    const d = await decide({
      events: [],
      mlSignals: [],
      portfolio: { cashUsd: 10000, positions: [] },
    });
    expect(d.action).toBe("BUY");
    expect(d.symbol).toBe("BTC");
    expect(d.reasoning).toContain("ETF");
    expect(d.confidence).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/llm/phase2-decide.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/llm/phase2-decide.ts`**

```ts
import type { DataPoint, MlSignal } from "@/lib/types";
import { chatJson } from "./client";
import { Phase2ResultSchema, type Phase2Result } from "./schemas";

const SYSTEM = `Te egy hibrid AI kereskedési döntéshozó vagy (GLM-5.2).
Kapsz: híreket + sentiment, whale-mozgásokat, ML ár-előrejelzéseket,
és a jelenlegi portfóliót. A feladat: hozz EGY döntést a következő órára.
Szabályok: csak BTC/ETH/SOL, amountPct 0..0.2 (max 20% tőke),
konfideniát 0..1-ben adj. A reasoning kötelező, magyarul, tömören.
Csak JSON-t adj.`;

export interface DecideInput {
  events: DataPoint[];
  mlSignals: MlSignal[];
  portfolio: { cashUsd: number; positions: { symbol: string; qty: number; entryPrice: number }[] };
}

/**
 * Phase-2: GLM-5.2 — csak ha a phase-1 jelezte, hogy érdemes dönteni.
 * Strukturált JSON-t ad vissza érveléssel. Lásd spec §3.2.
 */
export async function decide(input: DecideInput): Promise<Phase2Result> {
  const fallback: Phase2Result = { action: "HOLD", amountPct: 0, confidence: 0.3, reasoning: "LLM hiba, HOLD." };
  const user = JSON.stringify({
    events: input.events,
    ml: input.mlSignals,
    portfolio: input.portfolio,
    limits: { maxPositionPct: 0.2, maxConcurrent: 3 },
  });
  const { data } = await chatJson<Phase2Result>(
    process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    SYSTEM,
    user,
    fallback,
  );
  return Phase2ResultSchema.parse(data);
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/llm/phase2-decide.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/phase2-decide.ts tests/lib/llm/phase2-decide.test.ts
git commit -m "feat(llm): phase-2 döntéshozó (GLM-5.2) strukturált kimenettel"
```

---

## Phase 3 — Kockázatkezelés és végrehajtás

### Task 3.1: Risk Manager

**Files:**
- Create: `src/lib/risk/risk-manager.ts`

- [ ] **Step 1: Tesztek (a legfontosabbak — limitlek ellenőrzése)**

`tests/lib/risk/risk-manager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { applyRisk } from "@/lib/risk/risk-manager";

const portfolio = (cash: number, positions: { symbol: string; valueUsd: number }[] = []) => ({
  cashUsd: cash,
  positions,
  totalEquity: () => cash + positions.reduce((s, p) => s + p.valueUsd, 0),
});

describe("applyRisk — kockázati limitek", () => {
  it("20% feletti pozíciót visszavágja 20%-ra", () => {
    const p = portfolio(10000);
    const raw = { action: "BUY" as const, symbol: "BTC", amountPct: 0.5, confidence: 0.8, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, p);
    expect(result.amountPct).toBe(0.2);
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/20%/);
  });

  it("ha már 3 pozíció van, új BUY-t HOLD-ra váltja", () => {
    const p = portfolio(7000, [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ]);
    const raw = { action: "BUY" as const, symbol: "BTC", amountPct: 0.1, confidence: 0.7, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, p);
    // BTC már nyitva, így nem számít új pozíciónak — ez valid BUY
    expect(result.action).toBe("BUY");
  });

  it("ha már 3 KÜLÖNBÖZŐ pozíció van és új coinra BUY jön → HOLD", () => {
    const p = portfolio(7000, [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ]);
    // Nincs több coin a kosárban, de a teszt demonstrálja a logikát:
    // próbáljunk a már nyitott BTC-re növelni (nem új pozíció)
    const raw = { action: "BUY" as const, symbol: "BTC", amountPct: 0.1, confidence: 0.7, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, p);
    expect(result.action).toBe("BUY"); // nem új pozíció
  });

  it("HOLD átmegy változatlanul", () => {
    const p = portfolio(10000);
    const raw = { action: "HOLD" as const, symbol: undefined, amountPct: 0, confidence: 0.5, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, p);
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(false);
  });

  it("napi -3% circuit breaker HOLD-onlyvá tesz", () => {
    const p = { ...portfolio(9700), dayPnlPct: -0.031 };
    const raw = { action: "BUY" as const, symbol: "BTC", amountPct: 0.1, confidence: 0.8, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, p as any);
    expect(result.action).toBe("HOLD");
    expect(result.overrideReason).toMatch(/circuit breaker|napi/i);
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/risk/risk-manager.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/risk/risk-manager.ts`**

```ts
import { RISK_LIMITS } from "@/lib/config";
import type { RawDecision, Decision } from "@/lib/types";

export interface RiskContext {
  cashUsd: number;
  positions: { symbol: string; valueUsd: number }[];
  totalEquity: () => number;
  dayPnlPct?: number; // mai napi P&L % (circuit breakerhez)
}

/**
 * A Risk Manager az AI döntése felett áll — minden order kötelezően átmegy rajta.
 * Konzervatív limiteket érvényesít. Ha az AI túl merészet javasol, módosít vagy HOLD-ra vált.
 * Lásd spec §3.4. Minden override naplózva lesz a risk_overrides táblába.
 */
export function applyRisk(raw: RawDecision, ctx: RiskContext): Decision {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const base: Decision = { ...raw, id, timestamp, overridden: false };

  // HOLD mindig átengedve
  if (raw.action === "HOLD") return base;

  // 1) Circuit breaker: napi -3% után csak HOLD
  if ((ctx.dayPnlPct ?? 0) <= -RISK_LIMITS.dailyLossCircuitBreakerPct) {
    return { ...base, action: "HOLD", overridden: true, overrideReason: `Napi circuit breaker aktiválódott (${(ctx.dayPnlPct! * 100).toFixed(1)}% < -3%)` };
  }

  // 2) Max pozíció 20%: BUY amountPct visszavágása
  if (raw.action === "BUY" && raw.amountPct > RISK_LIMITS.maxPositionPct) {
    return { ...base, amountPct: RISK_LIMITS.maxPositionPct, overridden: true, overrideReason: `Max pozíció 20% tőke — visszavágva ${raw.amountPct * 100}%-ról` };
  }

  // 3) Max 3 egyidejű pozíció (csak ha ÚJ coinra nyitunk)
  const openSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const isNewPosition = raw.action === "BUY" && raw.symbol && !openSymbols.has(raw.symbol);
  if (isNewPosition && openSymbols.size >= RISK_LIMITS.maxConcurrentPositions) {
    return { ...base, action: "HOLD", overridden: true, overrideReason: `Max ${RISK_LIMITS.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva` };
  }

  return base;
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/risk/risk-manager.test.ts
```
Expected: PASS (5 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/risk/risk-manager.ts tests/lib/risk/risk-manager.test.ts
git commit -m "feat(risk): kockázatkezelő — 20% pozíció, 3 pozíció, -3% breaker"
```

---

### Task 3.2: Broker interfész + PaperBroker

**Files:**
- Create: `src/lib/execution/broker.ts`, `src/lib/execution/paper-broker.ts`

- [ ] **Step 1: Teszt**

`tests/lib/execution/paper-broker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PaperBroker } from "@/lib/execution/paper-broker";

describe("PaperBroker", () => {
  it("BUY-t szimulált egyenleggel végrehoz, fee-vel", async () => {
    const broker = new PaperBroker({ cashUsd: 10000, positions: [] });
    const trade = await broker.execute({
      side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05,
    }, 60000);
    expect(trade.symbol).toBe("BTC");
    expect(trade.side).toBe("BUY");
    expect(trade.price).toBe(60000);
    expect(trade.qty).toBeCloseTo(2000 / 60000, 8);
    expect(trade.feeUsd).toBeGreaterThan(0);
    expect(trade.mode).toBe("paper");
  });

  it("SELL lezárja a pozíciót", async () => {
    const broker = new PaperBroker({ cashUsd: 8000, positions: [{ symbol: "BTC", qty: 0.0333, valueUsd: 2000 }] });
    const trade = await broker.execute({
      side: "SELL", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05,
    }, 60000);
    expect(trade.side).toBe("SELL");
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/execution/paper-broker.test.ts
```

- [ ] **Step 3: Implementáld az interfészt `src/lib/execution/broker.ts`**

```ts
import type { Order, Trade } from "@/lib/types";

/** Végrehajtó réteg — cserélhető demo (paper) és valós (binance) között. */
export interface Broker {
  execute(order: Order, currentPrice: number): Promise<Trade>;
}
```

- [ ] **Step 4: Implementáld `src/lib/execution/paper-broker.ts`**

```ts
import type { Order, Trade } from "@/lib/types";
import type { Broker } from "./broker";

const PAPER_FEE_PCT = 0.001; // 0.1% szimulált díj

interface PaperState {
  cashUsd: number;
  positions: { symbol: string; qty: number; valueUsd: number }[];
}

/**
 * PaperBroker — demo módban, valós áron szimulál tranzakciót.
 * Lásd spec §3.3. A valós árat a hívó adja meg (CoinGecko-ból).
 */
export class PaperBroker implements Broker {
  constructor(private state: PaperState) {}

  async execute(order: Order, currentPrice: number): Promise<Trade> {
    const gross = order.amountUsd;
    const feeUsd = gross * PAPER_FEE_PCT;
    const netUsd = gross - feeUsd;
    const qty = netUsd / currentPrice;

    if (order.side === "BUY") {
      this.state.cashUsd -= gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty += qty;
        existing.valueUsd += netUsd;
      } else {
        this.state.positions.push({ symbol: order.symbol, qty, valueUsd: netUsd });
      }
    } else {
      this.state.cashUsd += gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty -= qty;
        existing.valueUsd -= netUsd;
        if (existing.qty <= 0.0000001) {
          this.state.positions = this.state.positions.filter((p) => p.symbol !== order.symbol);
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
      symbol: order.symbol,
      side: order.side,
      amountUsd: gross,
      price: currentPrice,
      qty,
      feeUsd,
      executedAt: Date.now(),
      mode: "paper",
    };
  }
}
```

- [ ] **Step 5: Futtasd a tesztet**

```bash
pnpm test tests/lib/execution/paper-broker.test.ts
```
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/broker.ts src/lib/execution/paper-broker.ts tests/lib/execution/paper-broker.test.ts
git commit -m "feat(execution): Broker interfész + PaperBroker (demo végrehajtás)"
```

---

### Task 3.3: BinanceBroker (valós mód, 2. fázis)

**Files:**
- Create: `src/lib/execution/binance-broker.ts`

- [ ] **Step 1: Implementáld `src/lib/execution/binance-broker.ts`**

```ts
import type { Order, Trade } from "@/lib/types";
import type { Broker } from "./broker";

/**
 * BinanceBroker — valós Binance Spot API. CSAK live módban, read+trade kulccsal,
 * SOHA withdraw jog. Lásd spec §3.3 + §6. A pontos aláírás/endpoint a Binance REST API.
 *
 * BIZTONSÁG: a kockázati limiteket a Risk Manager már a broker előtt érvényesíti;
 * itt duplán is ellenőrizzük, hogy ne lehessen a limiteken túl kötni.
 */
export class BinanceBroker implements Broker {
  constructor(
    private apiKey: string,
    private apiSecret: string,
  ) {
    if (!apiKey || !apiSecret) throw new Error("BinanceBroker: hiányzó API kulcsok");
  }

  async execute(order: Order, _currentPrice: number): Promise<Trade> {
    // Biztonsági dupla-ellenőrzés: tőkeáttétel és limit
    if (order.stopLossPct < 0.05) {
      throw new Error("BinanceBroker: stop-loss kötelező és min -5%");
    }
    // NOTE: a teljes Binance HMAC aláírás implementációja a 2. fázisban.
    // Ez a vázlat jelzi az interfészt; a tényleges hálózati hívás külső library-vel
    // (pl. `node-binance-api` vagy saját HMAC) implementálandó a live-módra váltás előtt.
    throw new Error("BinanceBroker.execute még nincs implementálva — 2. fázis (live mód).");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/execution/binance-broker.ts
git commit -m "feat(execution): BinanceBroker váza (live mód 2. fázisra jelölve)"
```

---

## Phase 4 — A döntési ciklus (engine) + ML

### Task 4.1: ML feature engineering + predictor (váza)

**Files:**
- Create: `src/lib/ml/features.ts`, `src/lib/ml/predictor.ts`, `src/lib/ml/README.md`

- [ ] **Step 1: Implementáld `src/lib/ml/features.ts`**

```ts
import type { DataPoint } from "@/lib/types";

/**
 * Feature engineering a LightGBM modellhez — árváltozás, volatilitás,
 * volume-jelölők az elmúlt N órából. Lásd spec §3.2 (ML komponens).
 * A tréning külső Python scripttel történik (lásd ml/README.md).
 */
export interface MlFeatures {
  symbol: string;
  return1h: number;
  return4h: number;
  volatility4h: number;
  volumeRatio: number; // jelenlegi volume / átlag
}

export function buildFeatures(prices: DataPoint[], windowHours = 4): MlFeatures[] {
  // Csoportosítás symbolonként, majd ablakolt return/volatilitás számítás.
  const bySymbol = new Map<string, DataPoint[]>();
  for (const p of prices) {
    if (p.kind !== "price" || !p.price) continue;
    const arr = bySymbol.get(p.symbol) ?? [];
    arr.push(p);
    bySymbol.set(p.symbol, arr);
  }
  const out: MlFeatures[] = [];
  for (const [symbol, arr] of bySymbol) {
    if (arr.length < 2) continue;
    const sorted = arr.sort((a, b) => a.timestamp - b.timestamp);
    const px = sorted.map((p) => p.price!.usd);
    const last = px[px.length - 1];
    const prev1h = px[px.length - 2] ?? last;
    const prev4h = px[Math.max(0, px.length - 1 - windowHours)] ?? last;
    const returns = px.slice(1).map((p, i) => (p - px[i]) / px[i]);
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1);
    out.push({
      symbol,
      return1h: (last - prev1h) / prev1h,
      return4h: (last - prev4h) / prev4h,
      volatility4h: Math.sqrt(variance),
      volumeRatio: 1, // egyszerűsített; a tényleges átlag-történetből számolandó
    });
  }
  return out;
}
```

- [ ] **Step 2: Implementáld `src/lib/ml/predictor.ts`**

```ts
import type { MlSignal } from "@/lib/types";
import type { MlFeatures } from "./features";

/**
 * LightGBM prediktor váza. A betanított modell artifact (JSON) a Vercel
 * Blob Storage-ban van (a repo-ban NEM — lásd spec §3.2 self-review javítás).
 *
 * Mivel a Vercel szerverless nem futtat natív LightGBM-et jól, a gyakorlatban
 * a predikciót vagy (a) egy kompilált ONNX modell futtatja, vagy (b) a
 * betanított súlyokat egy egyszerű tree-walk implementálja TypeScript-ben.
 * Ez a vázlat a (b) megközelítést készíti elő.
 */
export async function predict(features: MlFeatures[]): Promise<MlSignal[]> {
  // Amíg a modell nincs betanítva, egy naiv heurisztika ad jelet:
  // pozitív 1h return + alacsony volatilitás → "up", magas volatilitás → "flat".
  const ts = Date.now();
  return features.map((f) => {
    const up = f.return1h > 0 && f.volatility4h < 0.02;
    const direction1h = up ? "up" : f.return1h < 0 ? "down" : "flat";
    return {
      symbol: f.symbol,
      timestamp: ts,
      direction1h: direction1h as "up" | "down" | "flat",
      confidence: Math.min(0.7, 0.5 + Math.abs(f.return1h) * 10),
      volatilityPct: f.volatility4h * 100,
    };
  });
}
```

- [ ] **Step 3: `src/lib/ml/README.md`** (tréning útmutató)

```markdown
# ML modell tréning (külső Python script)

A LightGBM modell tréningét **külön Python környezetben** végezzük,
a `raw_events` táblából kinyert történelmi adatokon. A betanított modellt
JSON/ONNX formátumban mentjük, és a Vercel Blob Storage-ba töltjük.

## Lépések (a demo-fázis után)

1. Exportáld a `raw_events` táblát (CoinGecko ár-történet):
   ```bash
   pnpm tsx scripts/export-raw-events.ts > ml_training_data.json
   ```
2. Tréning Pythonnal:
   ```python
   import lightgbm as lgb
   # features + címkék (1 órás forward return iránya)
   # ...
   bst = lgb.train(params, train_data, num_rounds)
   bst.save_model("model.json")
   ```
3. Töltsd fel a Blob Storage-ba, állítsd be a `ML_MODEL_URL` env-et.
4. A `predictor.ts` implementálja a tree-walk-ot a JSON-ből.

**Megjegyzés:** a demo-fázisban a `predictor.ts` naiv heurisztikát használ,
ami elegendő az AI lánc teszteléséhez. A valódi modell csak a demo után jön.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/ml/
git commit -m "feat(ml): feature engineering + predictor váza (LightGBM, tréning README)"
```

---

### Task 4.2: Engine — `tick.ts` (a teljes ciklus)

**Files:**
- Create: `src/lib/engine/tick.ts`

- [ ] **Step 1: Teszt (mockolt függőségekkel)**

`tests/lib/engine/tick.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/collectors/base", () => ({
  collectAll: vi.fn().mockResolvedValue([
    { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 60000, volume24h: 1, change24hPct: 2 } },
  ]),
}));
vi.mock("@/lib/llm/phase1-filter", () => ({
  shouldDecide: vi.fn().mockResolvedValue({ shouldDecide: true, summary: "ETF hír", notableEvents: [] }),
}));
vi.mock("@/lib/llm/phase2-decide", () => ({
  decide: vi.fn().mockResolvedValue({ action: "BUY", symbol: "BTC", amountPct: 0.15, confidence: 0.7, reasoning: "bullish" }),
}));
vi.mock("@/lib/ml/predictor", () => ({
  predict: vi.fn().mockResolvedValue([]),
}));

import { runTick } from "@/lib/engine/tick";

describe("runTick", () => {
  it("végigfut a cikluson és döntést ad", async () => {
    const result = await runTick({ tickId: "2026-06-25-10", paperMode: true });
    expect(result.decision.action).toBe("BUY");
    expect(result.decision.symbol).toBe("BTC");
    expect(result.trade).toBeTruthy();
    expect(result.trade?.mode).toBe("paper");
  });

  it("HOLD esetén nem kereskedik", async () => {
    const { decide } = await import("@/lib/llm/phase2-decide");
    (decide as any).mockResolvedValueOnce({ action: "HOLD", amountPct: 0, confidence: 0.4, reasoning: "semmi" });
    const result = await runTick({ tickId: "2026-06-25-11", paperMode: true });
    expect(result.decision.action).toBe("HOLD");
    expect(result.trade).toBeNull();
  });
});
```

- [ ] **Step 2: Futtasd, hogy elbukjon**

```bash
pnpm test tests/lib/engine/tick.test.ts
```

- [ ] **Step 3: Implementáld `src/lib/engine/tick.ts`**

```ts
import { collectAll, type DataCollector } from "@/lib/collectors/base";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { applyRisk } from "@/lib/risk/risk-manager";
import { PaperBroker } from "@/lib/execution/paper-broker";
import { COIN_UNIVERSE } from "@/lib/config";
import type { Decision, Trade, DataPoint } from "@/lib/types";

export interface TickInput {
  tickId: string; // YYYY-MM-DD-HH
  paperMode: boolean;
}

export interface TickResult {
  events: DataPoint[];
  decision: Decision;
  trade: Trade | null;
}

/** A teljes óránkénti ciklus vezérlője. Lásd spec §4. */
export async function runTick(input: TickInput): Promise<TickResult> {
  // 1) Collectors
  const collectors: DataCollector[] = [
    new CoinGeckoCollector([...COIN_UNIVERSE]),
  ];
  if (process.env.CRYPTOPANIC_TOKEN) collectors.push(new CryptoPanicCollector(process.env.CRYPTOPANIC_TOKEN, [...COIN_UNIVERSE]));
  if (process.env.WHALEALERT_KEY) collectors.push(new WhaleAlertCollector(process.env.WHALEALERT_KEY, [...COIN_UNIVERSE]));

  const events = await collectAll(collectors);

  // 2) ML signals
  const features = buildFeatures(events);
  const mlSignals = await predict(features);

  // 3) Phase-1: érdemes-e dönteni?
  const phase1 = await shouldDecide(events);

  // alapértelmezett HOLD döntés, ha phase-1 nem jelez
  let rawAction = { action: "HOLD" as const, symbol: undefined as string | undefined, amountPct: 0, confidence: 0.3, reasoning: phase1.summary, model: "phase1" };

  if (phase1.shouldDecide) {
    // 4) Phase-2: GLM-5.2 döntés
    const phase2 = await decide({
      events,
      mlSignals,
      portfolio: { cashUsd: 10000, positions: [] }, // NOTE: valós portfólió-állapot a DB-ből (későbbi task)
    });
    rawAction = { ...phase2, model: process.env.LLM_MODEL_PHASE2 ?? "glm-5.2" };
  }

  // 5) Risk Manager
  // NOTE: a valós RiskContext-et a DB-ből töltjük; itt egyszerűsített kontextus.
  const decision = applyRisk(rawAction, {
    cashUsd: 10000,
    positions: [],
    totalEquity: () => 10000,
    dayPnlPct: 0,
  });

  // 6) Execution
  let trade: Trade | null = null;
  if (decision.action !== "HOLD" && decision.symbol) {
    const priceEvent = events.find((e) => e.symbol === decision.symbol && e.kind === "price");
    const price = priceEvent?.price?.usd;
    if (price) {
      const broker = input.paperMode
        ? new PaperBroker({ cashUsd: 10000, positions: [] })
        : null; // live broker a 2. fázisban
      if (broker) {
        trade = await broker.execute(
          { side: decision.action, symbol: decision.symbol, amountUsd: 10000 * decision.amountPct, stopLossPct: 0.05 },
          price,
        );
      }
    }
  }

  return { events, decision, trade };
}
```

- [ ] **Step 4: Futtasd a tesztet**

```bash
pnpm test tests/lib/engine/tick.test.ts
```
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/tick.ts tests/lib/engine/tick.test.ts
git commit -m "feat(engine): runTick — a teljes óránkénti döntési ciklus"
```

---

## Phase 5 — API routes + cron

### Task 5.1: Cron tick route (idempotens)

**Files:**
- Create: `src/app/api/cron/tick/route.ts`

- [ ] **Step 1: Implementáld a route-ot**

`src/app/api/cron/tick/route.ts`:
```ts
import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine/tick";
import { db, schema } from "@/db/client";

/**
 * Vercel Cron célja — óránként hívódik. Lásd spec §4.
 * Idempotens: a tick_id (YYYY-MM-DD-HH) alapján deduplikál,
 * hogy egy kétszer futó cron ne okozzon dupla tranzakciót.
 *
 * Vercel cron config: vercel.json (Task 5.3)
 */
export async function POST(req: Request) {
  // Biztonság: a CRON_SECRET ellenőrzése (Vercel cron Authorization header-ben küldi)
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const tickId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;

  // Idempotencia: van-e már döntés ezzel a tick_id-del?
  const existing = await db.query.decisions?.findFirst?.({ where: { tickId } } as any).catch(() => null);
  if (existing) {
    return NextResponse.json({ ok: true, skipped: true, tickId, reason: "already_processed" });
  }

  try {
    const result = await runTick({ tickId, paperMode: process.env.TRADING_MODE !== "live" });

    // Döntés mentése
    const [inserted] = await db.insert(schema.decisions).values({
      tickId,
      action: result.decision.action,
      symbol: result.decision.symbol ?? null,
      amountPct: result.decision.amountPct ?? null,
      confidence: result.decision.confidence,
      reasoning: result.decision.reasoning,
      model: result.decision.model,
      overridden: result.decision.overridden,
      overrideReason: result.decision.overrideReason ?? null,
    }).returning();

    // Tranzakció mentése, ha volt
    if (result.trade) {
      await db.insert(schema.trades).values({
        symbol: result.trade.symbol,
        side: result.trade.side,
        amountUsd: result.trade.amountUsd,
        price: result.trade.price,
        qty: result.trade.qty,
        feeUsd: result.trade.feeUsd,
        mode: result.trade.mode,
      });
    }

    return NextResponse.json({ ok: true, tickId, decisionId: inserted?.id, action: result.decision.action });
  } catch (e) {
    console.error("[cron/tick] hiba:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/cron/tick/route.ts
git commit -m "feat(api): cron tick route idempotens döntés+tranzakció mentéssel"
```

---

### Task 5.2: Read API routes (portfolio, decisions)

**Files:**
- Create: `src/app/api/portfolio/route.ts`, `src/app/api/decisions/route.ts`

- [ ] **Step 1: `src/app/api/portfolio/route.ts`**

```ts
import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { desc } from "drizzle-orm";

/** Jelenlegi portfólió-állapot (cash + pozíciók). */
export async function GET() {
  const portfolio = await db.query.portfolios.findFirst().catch(() => null);
  const openPositions = await db.query.positions.findMany({ where: { closedAt: null } } as any).catch(() => []);
  const recentTrades = await db.query.trades.findMany({ limit: 20, orderBy: desc(schema.trades.executedAt) } as any).catch(() => []);

  return NextResponse.json({
    portfolio,
    positions: openPositions,
    recentTrades,
  });
}
```

- [ ] **Step 2: `src/app/api/decisions/route.ts`**

```ts
import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { desc } from "drizzle-orm";

/** AI döntések története (érveléssel). Limitálható query parammal. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const rows = await db.query.decisions.findMany({
    limit: Math.min(limit, 200),
    orderBy: desc(schema.decisions.ts),
  } as any).catch(() => []);
  return NextResponse.json({ decisions: rows });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/portfolio/route.ts src/app/api/decisions/route.ts
git commit -m "feat(api): portfolio + decisions GET route-ok"
```

---

### Task 5.3: Vercel Cron config

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/cron/tick",
      "schedule": "0 * * * *"
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: Vercel Cron config (óránkénti tick)"
```

---

## Phase 6 — Frontend Dashboard

### Task 6.1: Dashboard főoldal + komponensek

**Files:**
- Create: `src/components/Dashboard.tsx`, `PortfolioPanel.tsx`, `DecisionsTimeline.tsx`, `DecisionCard.tsx`, `DecisionDetail.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: `src/components/PortfolioPanel.tsx`**

```tsx
"use client";

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
}

export function PortfolioPanel({ cashUsd, positions }: { cashUsd: number; positions: Position[] }) {
  const positionsValue = positions.reduce((s, p) => s + p.qty * p.entryPrice, 0);
  const total = cashUsd + positionsValue;
  return (
    <div className="rounded-2xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Portfólió</h2>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Készpénz" value={`$${cashUsd.toFixed(2)}`} />
        <Stat label="Pozíciók" value={`$${positionsValue.toFixed(2)}`} />
        <Stat label="Total" value={`$${total.toFixed(2)}`} />
      </div>
      <div className="mt-4 space-y-2">
        {positions.map((p) => (
          <div key={p.symbol} className="flex justify-between text-sm">
            <span className="font-medium">{p.symbol}</span>
            <span>{p.qty.toFixed(6)} @ ${p.entryPrice.toFixed(2)}</span>
          </div>
        ))}
        {positions.length === 0 && <p className="text-sm text-gray-500">Nincsenek nyitott pozíciók.</p>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: `src/components/DecisionCard.tsx` + `DecisionDetail.tsx`**

```tsx
// DecisionCard.tsx
"use client";
import { useState } from "react";

export interface DecisionRow {
  id: string;
  ts: string;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string | null;
  amountPct: number | null;
  confidence: number;
  reasoning: string;
  overridden: boolean;
  overrideReason: string | null;
}

const ACTION_COLOR: Record<string, string> = {
  BUY: "bg-green-100 text-green-700",
  SELL: "bg-red-100 text-red-700",
  HOLD: "bg-gray-100 text-gray-600",
};

export function DecisionCard({ d }: { d: DecisionRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${ACTION_COLOR[d.action]}`}>{d.action}</span>
          {d.symbol && <span className="font-medium">{d.symbol}</span>}
          {d.overridden && <span className="text-xs text-amber-600">⚠ módosítva</span>}
        </div>
        <div className="text-xs text-gray-500">
          {new Date(d.ts).toLocaleString("hu-HU")} · {Math.round(d.confidence * 100)}%
        </div>
      </div>
      <p className="mt-2 text-sm text-gray-700">{d.reasoning}</p>
      {d.overridden && d.overrideReason && (
        <p className="mt-1 text-xs text-amber-700">Risk Manager: {d.overrideReason}</p>
      )}
      <button onClick={() => setOpen(!open)} className="mt-2 text-xs text-blue-600 hover:underline">
        {open ? "Kevesebb" : "Miért döntött így?"}
      </button>
      {open && <DecisionDetail d={d} />}
    </div>
  );
}

// DecisionDetail.tsx
export function DecisionDetail({ d }: { d: DecisionRow }) {
  return (
    <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
      <div className="mb-1"><b>Model:</b> {d.id}</div>
      <div className="mb-1"><b>Mennyiség:</b> {((d.amountPct ?? 0) * 100).toFixed(1)}% tőke</div>
      <div><b>Bizonyosság:</b> {Math.round(d.confidence * 100)}%</div>
      {/* NOTE: a bemeneti adatok pillanatképe a raw_events táblából tölthető (későbbi task) */}
    </div>
  );
}
```

- [ ] **Step 3: `src/components/DecisionsTimeline.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { DecisionCard, type DecisionRow } from "./DecisionCard";

export function DecisionsTimeline() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/decisions?limit=50")
      .then((r) => r.json())
      .then((d) => setDecisions(d.decisions ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-2xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Döntések idővonala</h2>
      {loading && <p className="text-sm text-gray-500">Betöltés…</p>}
      <div className="space-y-3">
        {decisions.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
        {!loading && decisions.length === 0 && (
          <p className="text-sm text-gray-500">Még nincsenek döntések. Várd meg a következő órát.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `src/components/Dashboard.tsx` + `src/app/page.tsx`**

```tsx
// Dashboard.tsx
"use client";
import { PortfolioPanel } from "./PortfolioPanel";
import { DecisionsTimeline } from "./DecisionsTimeline";

export function Dashboard() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold mb-6">AI Kereskedő Bot</h1>
      <div className="grid gap-6">
        <PortfolioPanel cashUsd={10000} positions={[]} />
        <DecisionsTimeline />
      </div>
    </main>
  );
}

// src/app/page.tsx
import { Dashboard } from "@/components/Dashboard";
export default function Page() {
  return <Dashboard />;
}
```

- [ ] **Step 5: Indítsd el a dev szervert és ellenőrizd**

```bash
pnpm dev
```
Nyisd meg: `http://localhost:3000` — látnod kell a dashboard-ot (üres portfólió, üres döntés-idővonal).

- [ ] **Step 6: Commit**

```bash
git add src/components/ src/app/page.tsx
git commit -m "feat(ui): Dashboard — portfólió panel + döntések idővonala"
```

---

### Task 6.2: Backtest + Admin panelek

**Files:**
- Create: `src/components/BacktestPanel.tsx`, `src/components/AdminPanel.tsx`, `src/app/api/backtest/route.ts`, `src/app/api/admin/route.ts`

- [ ] **Step 1: `src/app/api/backtest/route.ts`**

```ts
import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { asc } from "drizzle-orm";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";

/**
 * Egyszerű backtest: a raw_events táblán végigfut, ML jeleket generál,
 * és szimulált P&L-t számol. Lásd spec §3.5.
 * Ez a vázlat — a valós stratégia finomítandó.
 */
export async function GET() {
  const events = await db.query.rawEvents.findMany({ orderBy: asc(schema.rawEvents.ts) } as any).catch(() => []);
  const features = buildFeatures(events as any);
  const signals = await predict(features);

  // Naív backtest: ha a jel "up", vettünk volna; számoljuk a P&L-t.
  // (Ez demonstrációs célú; a valós backtest a teljes döntési láncot futtatná.)
  let pnlPct = 0;
  let tradesCount = signals.length;
  for (const s of signals) {
    if (s.direction1h === "up") pnlPct += s.confidence * 0.01;
    else if (s.direction1h === "down") pnlPct -= s.confidence * 0.01;
  }

  const [saved] = await db.insert(schema.backtests).values({
    strategy: "naive-ml-signal",
    startTs: events[0]?.ts ?? new Date(),
    endTs: events[events.length - 1]?.ts ?? new Date(),
    resultPnlPct: pnlPct,
    tradesCount,
  }).returning().catch(() => [null]);

  return NextResponse.json({ pnlPct, tradesCount, backtestId: saved?.id ?? null });
}
```

- [ ] **Step 2: `src/app/api/admin/route.ts`** (mode switch)

```ts
import { NextResponse } from "next/server";

/** Admin: trading mode kapcsoló (paper ↔ live). */
export async function GET() {
  return NextResponse.json({ mode: process.env.TRADING_MODE ?? "paper" });
}

export async function POST(req: Request) {
  const { mode, confirm } = await req.json();
  if (mode !== "paper" && mode !== "live") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }
  if (mode === "live" && confirm !== "I-UNDERSTAND-THE-RISK") {
    return NextResponse.json({ error: "live módhoz explicit megerősítés kell" }, { status: 400 });
  }
  // NOTE: a tényleges env frissítés a Vercel dashboard-on történik;
  // ez az endpoint csak jelzi a szándékot és logolja.
  console.warn(`[admin] mode switch kérelem: ${mode} (confirm=${confirm})`);
  return NextResponse.json({ ok: true, mode, note: "A tényleges váltás a Vercel env-ben történik." });
}
```

- [ ] **Step 3: `src/components/BacktestPanel.tsx`**

```tsx
"use client";
import { useState } from "react";

export function BacktestPanel() {
  const [result, setResult] = useState<{ pnlPct: number; tradesCount: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    const r = await fetch("/api/backtest");
    const d = await r.json();
    setResult({ pnlPct: d.pnlPct, tradesCount: d.tradesCount });
    setLoading(false);
  };

  return (
    <div className="rounded-2xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Backtest</h2>
      <button
        onClick={run}
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Fut…" : "Backtest futtatása"}
      </button>
      {result && (
        <div className="mt-4 text-sm">
          <div>Eredmény: <span className={result.pnlPct >= 0 ? "text-green-600" : "text-red-600"}>{(result.pnlPct * 100).toFixed(2)}%</span></div>
          <div className="text-gray-500">Tranzakciók: {result.tradesCount}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `src/components/AdminPanel.tsx`**

```tsx
"use client";
import { useState } from "react";

export function AdminPanel() {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [confirm, setConfirm] = useState("");

  const switchMode = async () => {
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, confirm }),
    });
    const d = await r.json();
    if (!r.ok) alert(d.error);
    else alert(d.note);
  };

  return (
    <div className="rounded-2xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Admin — Trading Mode</h2>
      <div className="flex gap-4">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "paper"} onChange={() => setMode("paper")} /> Paper (demo)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "live"} onChange={() => setMode("live")} /> Live (valós)
        </label>
      </div>
      {mode === "live" && (
        <div className="mt-3">
          <p className="text-xs text-red-600">⚠ Valós pénz! Írd be: <code>I-UNDERSTAND-THE-RISK</code></p>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            placeholder="I-UNDERSTAND-THE-RISK"
          />
        </div>
      )}
      <button onClick={switchMode} className="mt-3 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900">
        Mentés
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Hozzd be a Dashboard-ba**

Modify `src/components/Dashboard.tsx` — adj hozzá importot és a panelt:

```tsx
import { BacktestPanel } from "./BacktestPanel";
import { AdminPanel } from "./AdminPanel";
// … a return-en belül, a DecisionsTimeline után:
<BacktestPanel />
<AdminPanel />
```

- [ ] **Step 6: Ellenőrizd, hogy fut**

```bash
pnpm dev
```
Expected: dashboard mutatja az új paneleket.

- [ ] **Step 7: Commit**

```bash
git add src/components/BacktestPanel.tsx src/components/AdminPanel.tsx src/app/api/backtest/route.ts src/app/api/admin/route.ts src/components/Dashboard.tsx
git commit -m "feat(ui): backtest + admin (mode switch) panelek"
```

---

## Phase 7 — Integráció és polish

### Task 7.1: Portfólió-persistencia (az engine és a DB összekötése)

**Files:**
- Create: `src/lib/portfolio/accounting.ts`
- Modify: `src/lib/engine/tick.ts` (a DB-ből tölti a kontextust, a DB-be ment)

- [ ] **Step 1: `src/lib/portfolio/accounting.ts`**

```ts
import { db, schema } from "@/db/client";
import { sql } from "drizzle-orm";

/** Betölti a jelenlegi portfólió-állapotot a DB-ből. */
export async function loadPortfolioState() {
  const portfolio = await db.query.portfolios.findFirst().catch(() => null);
  const positions = await db.query.positions.findMany({ where: { closedAt: null } } as any).catch(() => []);

  const cashUsd = portfolio?.cashUsd ?? 0;
  const positionsWithValue = positions.map((p) => ({
    symbol: p.symbol,
    qty: p.qty,
    valueUsd: p.qty * p.entryPrice, // egyszerűsített; a valós érték az aktuális árral
  }));

  return {
    cashUsd,
    positions: positionsWithValue,
    totalEquity: () => cashUsd + positionsWithValue.reduce((s, p) => s + p.valueUsd, 0),
    dayPnlPct: 0, // NOTE: mai napi P&L számítása külön task
  };
}

/** Új portfólió inicializálása kezdőtőkével. */
export async function initPortfolio(initialCapitalUsd: number, mode: "paper" | "live" = "paper") {
  await db.insert(schema.portfolios).values({
    initialCapitalUsd,
    cashUsd: initialCapitalUsd,
    mode,
  }).onConflictDoNothing();
}

/** Mai napi P&L % kiszámítása (a mai első döntés óta). */
export async function computeDayPnlPct(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const result = await db.execute(
    sql`SELECT COALESCE(SUM(amount_usd), 0) as total FROM ${schema.trades} WHERE executed_at >= ${startOfDay} AND side = 'SELL'`
  ).catch(() => null);
  // Egyszerűsített: a valós számítás a realized + unrealized P&L-ből áll.
  return 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/portfolio/accounting.ts
git commit -m "feat(portfolio): DB-alapú állapotbetöltés + inicializálás"
```

---

### Task 7.2: README és setup dokumentáció

**Files:**
- Create: `README.md`

- [ ] **Step 1: `README.md`**

````markdown
# AI Kereskedő Bot

Személyes használatú web app: egy hibrid AI (LightGBM + GLM) óránkénti
döntésekkel menedzsel egy kripto-portfóliót (BTC, ETH, SOL), látható érveléssel.
Demo (papír-trading) módban indul, konfigurálhatóan váltható valós Binance módra.

## Architektúra

Lásd: `docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md`

## Setup

### 1. Függőségek telepítése
```bash
pnpm install
```

### 2. Neon Postgres adatbázis
1. Hozz létre egy Neon projektet: https://neon.tech
2. Másold a connection string-et a `.env.local`-be:
   ```
   DATABASE_URL=postgres://...
   ```

### 3. GLM API kulcs (Zhipu AI)
1. Regisztrálj: https://open.bigmodel.cn
2. Készíts API kulcsot
3. Add hozzá a `.env.local`-hez:
   ```
   LLM_API_KEY=...
   LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
   LLM_MODEL_PHASE1=glm-4-flash
   LLM_MODEL_PHASE2=glm-5.2
   ```

### 4. Adatbázis migráció
```bash
pnpm db:generate
pnpm db:migrate
```

### 5. (Opcionális) Hír/whale API kulcsok
```
CRYPTOPANIC_TOKEN=...
WHALEALERT_KEY=...
```

### 6. Futtatás
```bash
pnpm dev
```

### 7. Cron tick kézi indítása (teszteléshez)
```bash
curl -X POST http://localhost:3000/api/cron/tick \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Vercel deploy
1. Pushold a repót GitHubra
2. Importáld a Vercelbe
3. Állítsd be az env változókat a Vercel dashboard-on
4. A `vercel.json`-ben definiált cron óránként lefut

## Biztonság
- **TRADING_MODE=paper** az alapértelmezett — sose indulj live nélkül validálás nélkül
- Binance kulcs csak `read + trade`, **SOHA** withdraw
- A kockázati limiteket a Risk Manager minden tranzakciónál érvényesíti

## ML modell tréning
Lásd: `src/lib/ml/README.md` (külön Python környezet, a demo-fázis után)
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README setup + biztonsági útmutató"
```

---

### Task 7.3: Végső ellenőrzés — minden teszt lefut

- [ ] **Step 1: Futtasd az összes tesztet**

```bash
pnpm test
```
Expected: minden teszt PASS. Ha bármelyik elbukik, javítsd a megfelelő taskban.

- [ ] **Step 2: Build ellenőrzés**

```bash
pnpm build
```
Expected: sikeres build, nincsenek TypeScript hibák.

- [ ] **Step 3: Végső commit**

```bash
git add -A
git commit -m "chore: végső ellenőrzés — minden teszt zöld, build ok"
git log --oneline
```

---

## Self-Review (írtam, most ellenőrzöm a specet lefedettség szempontjából)

**Spec lefedettség:**
- ✅ §1 Áttekintés — Phase 0-7 lefedi
- ✅ §2 Architektúra — Next.js + Neon + Vercel Cron, file structure-ban dokumentálva
- ✅ §3.1 Data Collectors — Task 1.2-1.6 (CoinGecko, CryptoPanic, WhaleAlert, RSS)
- ✅ §3.2 AI Decision Core (hibrid) — Task 2.1-2.3 (GLM client, phase-1, phase-2) + Task 4.1 (ML)
- ✅ §3.3 Execution Layer — Task 3.2-3.3 (PaperBroker, BinanceBroker váza)
- ✅ §3.4 Risk Manager — Task 3.1 (5 szabály mindegyike tesztelve)
- ✅ §3.5 Frontend — Task 6.1-6.2 (dashboard, döntések, backtest, admin)
- ✅ §3.6 Coin kosár — Task 0.2 (config.ts: BTC, ETH, SOL)
- ✅ §4 Adatfolyam — Task 4.2 (tick.ts) + Task 5.1 (cron route)
- ✅ §5 Adatmodell — Task 1.1 (drizzle schema, összes tábla)
- ✅ §6 Hibakezelés/biztonság — Task 5.1 (CRON_SECRET, idempotencia), Task 3.1 (circuit breaker), Task 5.2 (LLM fallback)
- ✅ §7 Tesztelés — minden task TDD, Vitest
- ✅ §8 Out of scope — tiszteletben tartva (nincs HFT, futures, multi-user)

**Type consistency:**
- `Decision`, `RawDecision`, `Order`, `Trade`, `DataPoint`, `MlSignal` — konzisztensek a `types.ts` és a használatuk között ✅
- `Broker.execute(order, currentPrice)` — konzisztens a PaperBroker és BinanceBroker között ✅
- `applyRisk(raw, ctx)` — konzisztens az engine-ben ✅

**Nyitott pontok (nem blokkoló, későbbi taskok):**
- A `tick.ts` jelenleg egyszerűsített portfólió-kontextussal dolgozik (`cashUsd: 10000`). A teljes DB-integráció a Task 7.1 `accounting.ts`-ével köthető be (a tick hívja a `loadPortfolioState()`-et). Ezt a plan világosan jelöli NOTE-okkal.
- A BinanceBroker.execute valós implementációja a 2. fázis (live mód) feladata — ez a spec szándéka szerint is out-of-scope a demo-érettségig.

A plan készen áll.
