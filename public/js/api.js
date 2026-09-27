// Accès à l'API et au WebSocket.
export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Erreur ${status}`);
    this.status = status;
    this.code = body && body.code;
    this.data = body && body.data;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body) {
  const opt = { method, headers: { 'X-SFTPad': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('api/' + url, opt); } catch { throw new ApiError(0, { error: 'Serveur injoignable' }); }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && err.code === 'NOAUTH') onUnauthorized();
    throw err;
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);
export const qs = (o) => new URLSearchParams(o).toString();

// Envoi de fichiers depuis l'appareil avec progression (XHR pour upload.onprogress).
export function uploadFiles(url, files, onProgress) {
  const fd = new FormData();
  for (const f of files) fd.append('file', f.file || f, f.rel || f.name);
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', 'api/' + url);
    xhr.setRequestHeader('X-SFTPad', '1');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress && onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'Envoi interrompu' }));
    xhr.onabort = () => reject(new ApiError(499, { error: 'Envoi annulé' }));
    xhr.send(fd);
  });
  promise.abort = () => xhr.abort();
  return promise;
}

// WebSocket avec reconnexion automatique.
export function connectWS(onMessage, onState) {
  let ws = null;
  let delay = 1000;
  let closed = false;
  const open = () => {
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 1000; onState && onState(true); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      onState && onState(false);
      if (!closed) setTimeout(open, delay);
      delay = Math.min(delay * 1.7, 15000);
    };
  };
  open();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState > 1) { delay = 300; }
  });
  return { close() { closed = true; ws && ws.close(); } };
}
