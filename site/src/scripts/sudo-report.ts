// `sudo` easter egg (no sound): a silent alarm flashes, then an ASCII dot-matrix printer files an incident report.
// Built from text nodes only (the attempted command is visitor-typed). Honors prefers-reduced-motion:
// no blinking, no typing effect, the report prints at once.

const W = 44; // printable columns between the tractor-feed margins
const CHARS_PER_TICK = 5;
const TICK_MS = 18;

export interface Printer { finish: () => void }

interface Options {
  out: HTMLElement;
  dialog: HTMLElement;
  attempt: string;
  onTick: () => void;
  onDone: (incident: string) => void;
}

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s;

function report(attempt: string, incident: string): string[] {
  const stamp = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return [
    '',
    center(`*** INCIDENT #${incident} ***`),
    '',
    `FILED     ${stamp}`,
    'USER      guest',
    `ATTEMPT   ${fit(`sudo ${attempt}`.trim(), W - 10)}`,
    'RESULT    DENIED',
    'SEVERITY  [##--------] mild audacity',
    'FINDING   Least privilege works.',
    '',
    '- - - - - - - - - tear here - - - - - - - - -'.slice(0, W),
  ];
}

export function printIncident({ out, dialog, attempt, onTick, onDone }: Options): Printer {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const incident = String(1000 + Math.floor(Math.random() * 9000));
  const lines = report(attempt, incident);

  const alarm = document.createElement('p');
  alarm.className = 'alarm';
  alarm.textContent = '[!] ALARM: privilege escalation attempt detected [!]';
  out.append(alarm);
  dialog.classList.add('alarming');
  setTimeout(() => dialog.classList.remove('alarming'), 1600);

  const paper = document.createElement('pre');
  paper.className = 'printer';
  paper.setAttribute('aria-hidden', 'true'); // the summary line printed at the end is what screen readers get
  out.append(paper);

  const rows = lines.map(() => {
    const row = document.createElement('span');
    const ink = document.createElement('span');
    ink.className = 'ink';
    row.append(' o | ', ink, ' | o\n');
    return { row, ink };
  });

  let r = 0;
  let k = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    rows.forEach(({ row, ink }, i) => {
      ink.textContent = lines[i].padEnd(W);
      if (!row.isConnected) paper.append(row);
    });
    onDone(incident);
  };

  const tick = () => {
    if (finished) return;
    if (r >= rows.length) return done();
    const { row, ink } = rows[r];
    if (!row.isConnected) paper.append(row);
    k = Math.min(lines[r].length, k + CHARS_PER_TICK);
    const head = k < lines[r].length ? '▌' : '';
    ink.textContent = (lines[r].slice(0, k) + head).padEnd(W);
    if (k >= lines[r].length) { r += 1; k = 0; }
    onTick();
    timer = setTimeout(tick, TICK_MS);
  };

  if (reduce) done();
  else timer = setTimeout(tick, 700); // let the alarm flash first
  return { finish: done };
}
