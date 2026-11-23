// Refuses non-local targets: the load test deletes lt% links and link:*, rl:*, clicks* keys.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

if (process.env.LOADTEST_ALLOW_REMOTE !== '1') {
  for (const name of ['DATABASE_URL', 'REDIS_URL']) {
    const value = process.env[name];
    if (!value) continue;
    let host = '';
    try {
      host = new URL(value).hostname;
    } catch {
      // unparsable: refused below
    }
    if (!LOCAL_HOSTS.includes(host)) {
      console.error(
        `Refusing to run: ${name} host "${host}" is not local (localhost, 127.0.0.1, ::1). ` +
          'Set LOADTEST_ALLOW_REMOTE=1 to override.',
      );
      process.exit(1);
    }
  }
}
