// Formata a lista de mensagens de uma sessao como um texto legivel, no
// formato "Atendente: ..." / "Lead: ...", para mandar pra Claude avaliar.
//
// ATENCAO — CALIBRACAO PENDENTE: ainda nao vimos um payload real de
// GET /session/{id}/message, entao os nomes de campo abaixo (fromMe,
// text, senderName, createdAt) sao a melhor suposicao com base no padrao
// comum de APIs de chat. Assim que virmos uma resposta real dessa rota,
// ajuste esta funcao para os nomes de campo corretos (ver README).
function formatTranscript(messages = []) {
  return messages
    .map((m) => {
      const from = m.fromMe || m.direction === 'OUTBOUND' || m.direction === 'out'
        ? 'Atendente'
        : 'Lead';
      const text = m.text || m.body || m.content || m.caption || '[mensagem sem texto — imagem/audio/documento]';
      const time = m.createdAt || m.timestamp || '';
      return `[${time}] ${from}: ${text}`;
    })
    .join('\n');
}

module.exports = { formatTranscript };
