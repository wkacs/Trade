import { z } from "zod";

/** Phase-1 kimenet: érdemes-e egyáltalán döntést hozni? */
export const Phase1ResultSchema = z.object({
  shouldDecide: z.boolean(),
  summary: z.string(),
  notableEvents: z
    .array(
      z.object({
        symbol: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
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
