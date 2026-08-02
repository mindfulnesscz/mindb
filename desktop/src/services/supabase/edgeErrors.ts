/* Why an edge function call failed, said in terms of what to do about it.
 *
 * Three failures arrive looking almost identical — a non-2xx with a JSON body — and they are fixed
 * in three completely different places. Getting the wording wrong costs real time: a staging
 * deployment that had not finished yet was reported as "check the edge runtime is running", which
 * sends someone to Docker on their laptop to debug a CI timing problem.
 *
 *   NOT DEPLOYED   404, function missing        → deploy it, or wait for CI
 *   UNREACHABLE    502/504, or a gateway body   → the runtime is not answering
 *   REFUSED        anything else                → the function ran and said no
 *
 * The distinction between the first two is not academic. Supabase reports both with a `message`
 * field rather than the `error` field our functions use, so a naive check lumps them together —
 * which is exactly how the misleading message above came about.
 */

/** Human-facing failure for a call to `functions/v1/<name>`. */
export function edgeFunctionError(fnName: string, status: number, rawBody: string): Error {
  let detail = rawBody
  let fromGateway = false
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; message?: string }
    // Our functions report their own refusals in `error`; the platform uses `message`.
    if (parsed.error) detail = parsed.error
    else if (parsed.message) { detail = parsed.message; fromGateway = true }
  } catch { /* raw body */ }

  /* Checked BEFORE the gateway heuristic, because a missing function is reported with a `message`
     too and would otherwise be diagnosed as a dead runtime. */
  if (status === 404) {
    return new Error(
      `${fnName} is not deployed (404): ${detail} — the code is in the repo but not on this `
      + `project yet. On staging or production that usually means CI has not finished; locally, `
      + `run \`supabase functions deploy ${fnName}\`.`,
    )
  }

  if (fromGateway || status === 502 || status === 504) {
    return new Error(
      `${fnName} unreachable (${status}): ${detail} — the function did not respond. `
      + `Locally, check the edge runtime is running (\`docker start supabase_edge_runtime_<project>\`).`,
    )
  }

  return new Error(`${fnName} refused (${status}): ${detail}`)
}
