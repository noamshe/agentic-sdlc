import { handler as hello } from './handlers/hello.mjs';

const routes = {
  hello
};

// Internal invocation: select a handler with { action: 'hello' }.
export const createRouter = (handlers = routes) => async (event, context) => {
  const action = event?.action;
  if (typeof action !== 'string' || !Object.hasOwn(handlers, action))
    throw new Error('Unknown inner Lambda action');
  return handlers[action](event, context);
};

export const handler = createRouter();
