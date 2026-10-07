import { handler as hello } from './handlers/hello.mjs';

const routes = {
  'GET /hello': hello
};

// HTTP API payload v2: dispatch only explicitly registered method/path pairs.
export const createRouter = (handlers = routes) => async (event, context) => {
  const route = `${event?.requestContext?.http?.method} ${event?.rawPath}`;
  if (!Object.hasOwn(handlers, route)) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Not found',
      isBase64Encoded: false
    };
  }
  return handlers[route](event, context);
};

export const handler = createRouter();
