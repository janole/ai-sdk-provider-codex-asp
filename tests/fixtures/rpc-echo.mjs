import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  try {
    const message = JSON.parse(line);

    if (message.method && message.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { ok: true, method: message.method } })}\n`);
      return;
    }

    if (message.method && message.id === undefined) {
      process.stdout.write(`${JSON.stringify({ method: 'notified', params: { method: message.method } })}\n`);
    }
  } catch {
    process.stdout.write(`${JSON.stringify({ id: -1, error: { code: -32700, message: 'parse error' } })}\n`);
  }
});
