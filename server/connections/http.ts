import { ConnectorError } from '../connectors/connector.js';

export async function boundedJson(
  response: Response,
  label: string,
  maxBytes = 10_000_000,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes)
    throw new ConnectorError('invalid', `${label} response exceeded the ${maxBytes} byte limit.`);
  if (!response.body) throw new ConnectorError('invalid', `${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new ConnectorError('invalid', `${label} response exceeded the ${maxBytes} byte limit.`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new ConnectorError('invalid', `${label} returned malformed JSON.`);
  }
}

export function classifyResponse(response: Response, provider: string): never {
  if (response.status === 401 || response.status === 403)
    throw new ConnectorError('auth', `${provider} rejected the authorization.`);
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after') || 60);
    throw new ConnectorError(
      'throttled',
      `${provider} is rate limiting this connection.`,
      Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 60_000,
    );
  }
  if (response.status >= 500)
    throw new ConnectorError('unavailable', `${provider} returned HTTP ${response.status}.`);
  throw new ConnectorError('invalid', `${provider} returned HTTP ${response.status}.`);
}

export async function safeFetch(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  provider: string,
  allowedHosts: (host: string) => boolean,
  timeoutMs = 30_000,
) {
  if (url.username || url.password || !allowedHosts(url.hostname))
    throw new ConnectorError('invalid', `${provider} endpoint is not allowed.`);
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const timedOut =
      error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    throw new ConnectorError(
      timedOut ? 'timeout' : 'unavailable',
      timedOut
        ? `${provider} did not answer within the time limit.`
        : `${provider} could not be reached safely.`,
    );
  }
  if (!response.ok) classifyResponse(response, provider);
  return response;
}
