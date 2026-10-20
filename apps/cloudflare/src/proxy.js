/** /proxy?url=https://api.openai.com/v1&path=/chat/completions —— 补 CORS，透传 SSE */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age': '86400',
};

function resolveUpstream(url) {
  const target = url.searchParams.get('url');
  if (!target) return null;
  const rest = url.searchParams.get('path') || '';
  const base = target.replace(/\/+$/, '');
  return base + (rest ? (rest.startsWith('/') ? rest : '/' + rest) : '');
}

export async function handleProxy(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const upstream = resolveUpstream(url);
  if (!upstream) {
    return new Response('缺少 url 参数：/proxy?url=https://api.openai.com/v1&path=/chat/completions', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
    });
  }

  const headers = new Headers();
  const pass = ['content-type', 'authorization', 'accept'];
  for (const key of pass) {
    const v = request.headers.get(key);
    if (v) headers.set(key, v);
  }

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  const upstreamRes = await fetch(upstream, init);
  const out = new Headers(CORS);
  const ct = upstreamRes.headers.get('content-type');
  if (ct) out.set('Content-Type', ct);
  const cd = upstreamRes.headers.get('content-disposition');
  if (cd) out.set('Content-Disposition', cd);

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out });
}
