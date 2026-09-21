import {handleApi, securityHeaders} from './api.js';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApi(request, {...env, REQUIRE_PASSWORD: 'true'});
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(securityHeaders)) response.headers.set(key, value);
    return response;
  }
};
