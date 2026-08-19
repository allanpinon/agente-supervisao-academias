// Utilidades de data/fuso horario. Todas as datas do GymBot vem em UTC —
// aqui convertemos para o fuso do negocio (America/Sao_Paulo por padrao)
// antes de decidir "a que dia" um evento pertence.
const { DateTime } = require('luxon');
const { config } = require('../config');

function nowLocal() {
  return DateTime.now().setZone(config.timezone);
}

function toLocal(isoString) {
  return DateTime.fromISO(isoString, { zone: 'utc' }).setZone(config.timezone);
}

function todayLocalDateOnly() {
  return nowLocal().toFormat('yyyy-MM-dd');
}

// Verdadeiro se "hoje" (no fuso configurado) for o ultimo dia do mes.
function isLastDayOfMonth() {
  const today = nowLocal();
  const tomorrow = today.plus({ days: 1 });
  return tomorrow.month !== today.month;
}

// Datas de inicio/fim (local) do dia de hoje.
function todayRange() {
  const today = nowLocal();
  return { start: today.startOf('day'), end: today.endOf('day') };
}

// Datas de inicio/fim (local) da semana anterior completa (segunda a domingo).
function lastWeekRange() {
  const today = nowLocal();
  const startOfThisWeek = today.startOf('week'); // luxon: semana comeca na segunda
  const start = startOfThisWeek.minus({ weeks: 1 });
  const end = startOfThisWeek.minus({ days: 1 }).endOf('day');
  return { start, end };
}

// Datas de inicio/fim (local) do mes corrente (usado no fechamento mensal,
// que roda no ultimo dia do proprio mes).
function currentMonthRange() {
  const today = nowLocal();
  return { start: today.startOf('month'), end: today.endOf('day') };
}

function diffInDays(isoStart, isoEnd) {
  const start = DateTime.fromISO(isoStart);
  const end = DateTime.fromISO(isoEnd);
  return end.diff(start, 'days').days;
}

module.exports = {
  nowLocal,
  toLocal,
  todayLocalDateOnly,
  isLastDayOfMonth,
  todayRange,
  lastWeekRange,
  currentMonthRange,
  diffInDays,
};
