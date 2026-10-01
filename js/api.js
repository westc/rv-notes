// Talks to a spreadsheet's Apps Script web app (apps-script/Code.gs).

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {string} code "network" (couldn't reach it, e.g. offline), "auth"
   *     (wrong key), "setup" (the URL isn't an RV Notes web app), or "server".
   */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{url: string, key: string}} connection
 * @param {string} action
 * @param {Object=} params
 */
export async function callApi(connection, action, params = {}, { timeout = 90000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(connection.url, {
      method: 'POST',
      // text/plain avoids a CORS preflight request, which Apps Script can't
      // answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: connection.key, action, params }),
      // No Google cookies are sent. The key is what grants access.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (err) {
    throw new ApiError(navigator.onLine === false
      ? 'You’re offline.'
      : 'Couldn’t reach the spreadsheet. Check your internet connection. If this keeps happening, make sure the web app’s “Who has access” is set to “Anyone”.',
    'network');
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    // Handled below.
  }
  if (!body || typeof body.ok !== 'boolean') {
    throw new ApiError(response.ok
      ? 'The spreadsheet didn’t answer like RV Notes. Check that the link has the web app URL (ending in /exec) and that the script was deployed.'
      : `The spreadsheet’s web app had a problem (${response.status}). Try again later.`,
    response.ok ? 'setup' : 'network');
  }
  if (!body.ok) throw new ApiError(body.error || 'Something went wrong.', body.code || 'server');
  return body.result;
}
