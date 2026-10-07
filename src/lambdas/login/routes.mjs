import { handler as login } from './handlers/login.mjs';

const routes = {
  'GET /login': login
};

export const handler = async (event, context) => {
  const route = `${event?.requestContext?.http?.method} ${event?.rawPath}`;
  if (!Object.hasOwn(routes, route))
    return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
  return routes[route](event, context);
};
