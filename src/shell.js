export function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function shellJoin(values) {
  return values.map(shellQuote).join(' ');
}

function isSafeRemoteDirectory(value) {
  return (
    /^[a-zA-Z0-9_./-]+$/.test(value)
    && !value.startsWith('/')
    && !value.split('/').includes('..')
  );
}

export function buildRemoteExec(args, remoteDirectory = '') {
  const command = `exec ${shellJoin(args)}`;
  if (!remoteDirectory) return command;
  if (!isSafeRemoteDirectory(remoteDirectory)) {
    throw new Error('unsafe generated remote directory');
  }
  return `cd "$HOME/${remoteDirectory}" && ${command}`;
}
