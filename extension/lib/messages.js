export const MSG = Object.freeze({
  PING: 'PING',
  MEDIA_URL_DETECTED: 'MEDIA_URL_DETECTED',
  MANIFEST_BODY: 'MANIFEST_BODY',
  PAGE_META: 'PAGE_META',
  GET_TAB_STATE: 'GET_TAB_STATE',
  TAB_STATE_UPDATED: 'TAB_STATE_UPDATED',
  START_DOWNLOAD: 'START_DOWNLOAD',
  RUN_DOWNLOAD: 'RUN_DOWNLOAD',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_DONE: 'DOWNLOAD_DONE',
  DOWNLOAD_ERROR: 'DOWNLOAD_ERROR',
  PROXY_FETCH: 'PROXY_FETCH',
});

export function envelope(type, payload = {}, requestId) {
  const msg = { type, payload };
  if (requestId !== undefined) msg.requestId = requestId;
  return msg;
}
