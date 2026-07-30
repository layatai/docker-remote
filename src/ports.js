function normalizeDocuments(output) {
  const text = output.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function parseComposePorts(output) {
  const forwards = [];
  const seen = new Set();
  for (const container of normalizeDocuments(output)) {
    const publishers = container.Publishers ?? container.publishers ?? [];
    for (const publisher of publishers ?? []) {
      const protocol = String(publisher.Protocol ?? publisher.protocol ?? 'tcp').toLowerCase();
      const publishedPort = Number(publisher.PublishedPort ?? publisher.published_port ?? 0);
      if (protocol !== 'tcp' || !Number.isInteger(publishedPort) || publishedPort < 1) continue;
      const key = `${publishedPort}/tcp`;
      if (seen.has(key)) continue;
      seen.add(key);
      forwards.push({
        localHost: '127.0.0.1',
        localPort: publishedPort,
        remoteHost: '127.0.0.1',
        remotePort: publishedPort,
        protocol,
      });
    }
  }
  return forwards;
}

export function mergeForwards(...groups) {
  const result = [];
  const seen = new Set();
  for (const forward of groups.flat()) {
    const key = `${forward.localHost}:${forward.localPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(forward);
  }
  return result;
}
