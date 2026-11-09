// Await asynchronous bridge checks; Playwright waitForFunction predicates are synchronous.
async function poll(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
module.exports = { poll };
