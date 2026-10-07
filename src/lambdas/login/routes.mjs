import { handler as login } from './handlers/login.mjs';
import { handler as backOffice } from './handlers/back-office.mjs';
import { handler as agenticFlow } from './handlers/agentic-flow.mjs';

const routes = {
  'GET /login': login,
  'GET /back-office': backOffice,
  'GET /agentic-flow': agenticFlow
};

export const handler = async (event, context) => {
  const route = `${event?.requestContext?.http?.method} ${event?.rawPath}`;
  if (!Object.hasOwn(routes, route))
    return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
  return routes[route](event, context);
};
