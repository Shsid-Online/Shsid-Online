// Hiding is distinct from deleting. Only administrators may restore visibility.
const canHidePosts = user => user?.status !== 'banned' && ['admin', 'moderator'].includes(user?.role);
const canReadPost = (post, user) => Boolean(post && !post.deletedAt && !post.deleted_at &&
  (!(post.hiddenAt || post.hidden_at) || user?.role === 'admin'));
function moderatorRouteAllowed(method, route) {
  if (method === 'GET') return route === '/me' || route === '/posts' || /^\/posts\/[^/]+$/.test(route)
    || route.startsWith('/media/uploads') || route === '/health' || route === '/posting-config';
  return method === 'POST' && (route === '/auth/logout' || route === '/auth/login' || /^\/posts\/[^/]+\/hide$/.test(route));
}
module.exports = { canHidePosts, canReadPost, moderatorRouteAllowed };
