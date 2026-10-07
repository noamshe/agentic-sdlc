export const handler = async () => {
  const message = 'hello from new lambda';
  console.log(message);
  return { message };
};
