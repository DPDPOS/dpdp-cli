/**
 * Backend HTTP client.
 *
 * Phase 1/2 constraints: endpoints, Authorization behavior, error handling
 * and the evidence payload are preserved exactly. No new endpoints, no auth
 * redesign. `apiBaseUrl` and `token` are passed explicitly — the transport
 * never reads local storage, and scanning produces evidence independently
 * of HTTP.
 */
export async function api(
  apiBaseUrl: string,
  token: string,
  method: string,
  apiPath: string,
  body?: unknown,
) {
  const res = await fetch(`${apiBaseUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: { success?: boolean; data?: unknown; error?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    throw new Error(
      `API ${method} ${apiPath} returned non-JSON (${res.status}). ` +
        `Is the backend assessment spine running at ${apiBaseUrl}? ` +
        `Body starts with: ${text.slice(0, 80).replace(/\s+/g, " ")}`,
    );
  }

  if (!res.ok || json.success === false) {
    throw new Error(
      `API ${method} ${apiPath} failed (${res.status}): ${JSON.stringify(json.error ?? json)}`,
    );
  }
  return json.data;
}
