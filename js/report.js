// Monthly report math: totals, whole hours with leftover minutes carried into
// the next month, Bible studies, and the text that gets sent.
//
// Months are "yyyy-mm" and days are "yyyy-mm-dd", both in local time.

const pad = n => String(n).padStart(2, '0');

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7);
}

export function addMonths(month, count) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(year, m - 1 + count, 1);
  return monthKey(date);
}

export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function reportId(month) {
  return `report-${month}`;
}

export function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Works out a month's whole hours for one kind of time ("service" or
 * "credit"). Leftover minutes carry into the next month. A month whose report
 * was sent keeps the numbers that were sent, so later edits don't change what
 * the next month starts with.
 */
function hoursFor(time, reports, month, kind) {
  const minutesByMonth = {};
  time.filter(entry => entry.kind === kind).forEach(entry => {
    const m = entry.date.slice(0, 7);
    minutesByMonth[m] = (minutesByMonth[m] || 0) + entry.minutes;
  });
  const sent = {};
  reports.filter(report => report.sentAt).forEach(report => sent[report.month] = report);
  const hoursKey = kind === 'credit' ? 'creditHours' : 'hours';
  const carryKey = kind === 'credit' ? 'carriedCreditMinutes' : 'carriedMinutes';

  const months = [...Object.keys(minutesByMonth), ...Object.keys(sent)].filter(m => m <= month).sort();
  let carriedIn = 0;
  for (let m = months[0] || month; m <= month; m = addMonths(m, 1)) {
    const minutes = minutesByMonth[m] || 0;
    const total = carriedIn + minutes;
    let hours = Math.floor(total / 60);
    let carriedOut = total % 60;
    const report = sent[m];
    if (report && report[hoursKey] !== '' && report[carryKey] !== '') {
      hours = report[hoursKey];
      carriedOut = report[carryKey];
    }
    if (m === month) {
      // live* is what would be sent now; hours and carriedOut keep what a sent
      // report sent.
      return { minutes, carriedIn, hours, carriedOut, liveHours: Math.floor(total / 60), liveCarriedOut: total % 60 };
    }
    carriedIn = carriedOut;
  }
  return { minutes: 0, carriedIn: 0, hours: 0, carriedOut: 0, liveHours: 0, liveCarriedOut: 0 };
}

/**
 * The same person or name added twice (say, on two phones) counts once.
 */
export function uniqueStudies(studies, month) {
  const seen = new Set();
  return studies
    .filter(study => study.month === month)
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(study => {
      const key = study.personId || `name:${study.name.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * @param {{time: Object[], studies: Object[], reports: Object[], visits: Object[]}} data
 * @param {string} month
 */
export function summarize(data, month) {
  const report = data.reports.find(r => r.month === month) || null;
  const service = hoursFor(data.time, data.reports, month, 'service');
  const credit = hoursFor(data.time, data.reports, month, 'credit');
  const studies = uniqueStudies(data.studies, month);
  const entries = data.time
    .filter(entry => entry.date.slice(0, 7) === month)
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  const hadVisit = data.visits.some(visit => monthKey(new Date(visit.createdAt)) === month);
  const sharedAuto = service.minutes > 0 || studies.length > 0 || hadVisit;
  const shared = report && report.shared ? report.shared === 'yes' : sharedAuto;
  const sent = !!(report && report.sentAt);
  return {
    month,
    report,
    entries,
    studies,
    service,
    credit,
    sharedAuto,
    shared,
    comments: report ? report.comments : '',
    sent
  };
}

/**
 * The text that's shared.
 */
export function reportText(summary, { name = '' } = {}) {
  const lines = [`Ministry report for ${monthLabel(summary.month)}`];
  if (name.trim()) lines.push(`Name: ${name.trim()}`);
  lines.push(`Shared in the ministry: ${summary.shared ? 'Yes' : 'No'}`);
  lines.push(`Bible studies: ${summary.studies.length}`);
  lines.push(`Hours: ${summary.service.liveHours}`);
  if (summary.credit.liveHours) lines.push(`Credit hours: ${summary.credit.liveHours}`);
  if (summary.comments.trim()) lines.push(`Comments: ${summary.comments.trim()}`);
  return lines.join('\n');
}

/**
 * Months worth listing in the report history, newest first. Always includes
 * the current month.
 */
export function reportMonths(data) {
  const months = new Set([monthKey()]);
  data.time.forEach(entry => months.add(entry.date.slice(0, 7)));
  data.studies.forEach(study => months.add(study.month));
  data.reports.forEach(report => months.add(report.month));
  return [...months].sort().reverse();
}
