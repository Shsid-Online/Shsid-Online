export function loginUrl(env, state) {
  const url = new URL("https://www.facebook.com/v26.0/dialog/oauth");
  url.searchParams.set("client_id", env.FACEBOOK_APP_ID);
  url.searchParams.set("redirect_uri", env.FACEBOOK_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (env.FACEBOOK_CONFIG_ID) url.searchParams.set("config_id", env.FACEBOOK_CONFIG_ID);
  else url.searchParams.set("scope", "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement");
  return url.toString();
}

export async function exchangeConnection(env, code) {
  async function get(path, parameters, token) {
    const url = new URL(`https://graph.facebook.com/v26.0/${path}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(25000) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(`Meta connection failed (code ${Number(data.error?.code) || response.status}). Check permissions and account status.`);
    return data;
  }
  const short = await get("oauth/access_token", { client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: env.FACEBOOK_REDIRECT_URI, code });
  const long = await get("oauth/access_token", { grant_type: "fb_exchange_token", client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, fb_exchange_token: short.access_token });
  const permissions = await get("me/permissions", {}, long.access_token);
  for (const required of ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"]) {
    if (!permissions.data?.some(p => p.permission === required && p.status === "granted")) throw new Error(`Missing ${required}. Update the Meta login configuration and reconnect.`);
  }
  const pages = await get("me/accounts", { fields: "id,instagram_business_account", limit: "100" }, long.access_token);
  const accounts = (pages.data || []).map(p => p.instagram_business_account?.id).filter(Boolean);
  const userId = env.INSTAGRAM_USER_ID ? accounts.find(id => id === env.INSTAGRAM_USER_ID) : accounts.length === 1 ? accounts[0] : null;
  if (!userId) throw new Error("No unique linked Instagram account found. Link your Instagram to a Facebook Page, or configure INSTAGRAM_USER_ID if you manage multiple accounts.");
  return { userId, token: long.access_token, expiresAt: Date.now() + Number(long.expires_in || 5184000) * 1000 };
}

export function mediaKey(imageUrl, origin) {
  const url = new URL(String(imageUrl || ""));
  if (url.origin !== origin || !url.pathname.startsWith("/api/media/") || url.search || url.hash) throw new Error("Use an image uploaded to this site");
  const key = decodeURIComponent(url.pathname.slice("/api/media/".length));
  if (!/^uploads\/[a-zA-Z0-9_.-]+\.jpe?g$/i.test(key)) throw new Error("Screenshot must be an uploaded JPEG");
  return key;
}
