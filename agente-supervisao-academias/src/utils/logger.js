// Logger simples — imprime no console (o Railway captura isso
// automaticamente na aba "Logs"). Sem dependencia externa, para manter
// o servico leve.
function withTimestamp(level, args) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level](`[${ts}]`, ...args);
}

module.exports = {
  info: (...args) => withTimestamp('log', args),
  warn: (...args) => withTimestamp('warn', args),
  error: (...args) => withTimestamp('error', args),
};
