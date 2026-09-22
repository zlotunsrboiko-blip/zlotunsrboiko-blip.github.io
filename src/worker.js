import {handleApi, securityHeaders} from './api.js';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      const origin = request.headers.get('Origin');
      const crossOrigin = origin && origin !== new URL(request.url).origin;
      if (crossOrigin && origin !== env.GITHUB_PAGES_ORIGIN) return new Response('Origin not allowed', {status:403});
      const cors = crossOrigin ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-App-Request, X-Market-Key, X-Business-Id, X-Campaign-Id, X-App-Password'} : {};
      if (request.method === 'OPTIONS') return new Response(null, {status:204,headers:cors});
      // Exact trusted Pages origin was checked above; API guard then checks the request marker.
      const headers = new Headers(request.headers);
      if (crossOrigin) headers.delete('Origin');
      const trusted = new Request(request, {headers});
      const result = await handleApi(trusted, {...env, REQUIRE_PASSWORD:'true'});
      const response = new Response(result.body, result);
      for (const [key,value] of Object.entries(cors)) response.headers.set(key,value);
      return response;
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(securityHeaders)) response.headers.set(key, value);
    return response;
  }
};
