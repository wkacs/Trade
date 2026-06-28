/**
 * Dead-man's-switch heartbeat. A tick SIKERKOR pingeli a HEARTBEAT_URL-t; egy külső
 * szolgáltatás (pl. healthchecks.io) riaszt, ha a ping a grace-period alatt NEM érkezik
 * meg (= a bot elhallgatott). Best-effort: env nélkül no-op, hibát elnyel, SOHA nem dob.
 *
 * USER-SETUP (külső, egyszeri):
 *   1) healthchecks.io → új check: period 1h, grace ~90 perc (a GitHub-cron hézagaihoz).
 *   2) másold a ping-URL-t HEARTBEAT_URL néven a GitHub repo-secretek közé
 *      (Settings → Secrets → Actions) ÉS a Vercel env-be (production).
 *   3) állítsd be a riasztás-csatornát (e-mail) a healthchecks.io-n.
 * Amíg nincs beállítva, ez a kód csendben no-op — semmi nem törik.
 */
export async function pingHeartbeat(ok: boolean): Promise<void> {
  const url = process.env.HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(ok ? url : `${url}/fail`);
  } catch (e) {
    console.error("[heartbeat] ping hiba:", e);
  }
}
