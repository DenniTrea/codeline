export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error(
      "Could not reach CodeLine. Check the connection and try again.",
    );
  }
  if (response.status === 204) return null as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "The server returned an incomplete response. Please retry."
        : `CodeLine is temporarily unavailable (${response.status}). Please retry.`,
    );
  }
  if (!response.ok)
    throw new Error(
      (data as { error?: string })?.error ||
        "Could not complete this request. Please retry.",
    );
  return data as T;
}
