// Terminal overlay. All output is built with DOM text nodes, never innerHTML,
// so nothing a visitor types can become markup.
import {
  profile, summary, roles, earlierTitles, certifications, skills, projects, awards, education, training,
} from '../data/resume';
import { stride } from '../data/threat-model';

type Part = string | { text: string; cls?: string; href?: string };
type Line = Part[] | string;

interface Post { title: string; href: string; date: string }

const BANNER = String.raw`
     _                       ____       _       _ _  __  __
    | | __ _ ___  ___  _ __ |  _ \ __ _| |_ ___| (_)/ _|/ _| ___
 _  | |/ _' / __|/ _ \| '_ \| |_) / _' | __/ __| | | |_| |_ / _ \
| |_| | (_| \__ \ (_) | | | |  _ < (_| | || (__| | |  _|  _|  __/
 \___/ \__,_|___/\___/|_| |_|_| \_\__,_|\__\___|_|_|_| |_|  \___|`;

const FILES: Record<string, () => Line[]> = {
  'summary.txt': () => [summary],
  'certs.txt': () => certifications.map((c) => [{ text: '✓ ', cls: 'ok' }, c.name]),
  'education.txt': () => [
    `${education.school}`, `${education.degree} (${education.date})`, '', 'Training:', ...training.map((t) => `  - ${t}`),
  ],
  'awards.txt': () => awards.flatMap((a) => [[{ text: `${a.year} `, cls: 'acc' }, a.name], [{ text: `     ${a.detail}`, cls: 'dim' }]]),
  '.env': () => [[{ text: 'nice try. secrets live in AWS, not in your browser. 🙂', cls: 'warn' }]],
};

export function initTerminal(): void {
  const dialog = document.getElementById('terminal') as HTMLDialogElement | null;
  if (!dialog) return;
  const out = dialog.querySelector<HTMLElement>('[data-terminal-out]')!;
  const form = dialog.querySelector<HTMLFormElement>('[data-terminal-form]')!;
  const input = dialog.querySelector<HTMLInputElement>('[data-terminal-input]')!;
  const screen = dialog.querySelector<HTMLElement>('[data-terminal-screen]')!;
  const posts: Post[] = JSON.parse(dialog.dataset.posts || '[]');

  const history: string[] = [];
  let hIndex = 0;
  let greeted = false;

  const print = (line: Line = '') => {
    const p = document.createElement('p');
    const parts = typeof line === 'string' ? [line] : line;
    for (const part of parts) {
      if (typeof part === 'string') { p.append(part); continue; }
      const el = part.href ? document.createElement('a') : document.createElement('span');
      el.textContent = part.text;
      if (part.cls) el.className = part.cls;
      if (el instanceof HTMLAnchorElement && part.href) {
        el.href = part.href;
        if (/^https?:/.test(part.href)) el.rel = 'noopener noreferrer';
      }
      p.append(el);
    }
    out.append(p);
  };
  const printPre = (text: string) => {
    const pre = document.createElement('pre');
    pre.setAttribute('aria-hidden', 'true');
    pre.textContent = text;
    out.append(pre);
  };
  const scrollDown = () => { screen.scrollTop = screen.scrollHeight; };

  const goTo = (href: string) => {
    dialog.close();
    window.location.href = href;
  };

  const commands: Record<string, { help: string; run: (args: string[]) => void; hidden?: boolean }> = {
    help: {
      help: 'list commands',
      run: () => {
        print([{ text: 'Available commands', cls: 'acc' }]);
        for (const [name, c] of Object.entries(commands)) {
          if (!c.hidden) print([{ text: `  ${name.padEnd(14)}`, cls: 'ok' }, { text: c.help, cls: 'dim' }]);
        }
        print([{ text: 'Tip: Tab completes, ↑/↓ walks history, Esc closes.', cls: 'dim' }]);
      },
    },
    whoami: {
      help: 'who is this?',
      run: () => {
        print([{ text: profile.name, cls: 'acc' }, ` – ${profile.title}`]);
        print(profile.tagline);
        print([{ text: `${profile.location} · ${profile.yearsExperience}+ years · `, cls: 'dim' }, { text: 'linkedin', href: profile.linkedin }]);
      },
    },
    summary: { help: 'professional summary', run: () => print(summary) },
    experience: {
      help: 'roles at USAA  (experience <n> for details)',
      run: ([n]) => {
        const i = n ? Number(n) - 1 : -1;
        if (i >= 0 && roles[i]) {
          const r = roles[i];
          print([{ text: r.title, cls: 'acc' }, { text: `  ${r.start} – ${r.end}`, cls: 'dim' }]);
          r.bullets.forEach((b) => print(`  • ${b}`));
          return;
        }
        print([{ text: 'USAA – San Antonio, TX', cls: 'acc' }]);
        roles.slice(0, 2).forEach((r, idx) => print([{ text: `  [${idx + 1}] `, cls: 'ok' }, r.title, { text: `  ${r.start} – ${r.end}`, cls: 'dim' }]));
        print([{ text: '  [3] ', cls: 'ok' }, 'Earlier roles:']);
        earlierTitles.forEach((t) => print([{ text: `      ${t.title}  ${t.start} – ${t.end}`, cls: 'dim' }]));
        print([{ text: 'Run `experience 1` (or 2, 3) for the details.', cls: 'dim' }]);
      },
    },
    certs: { help: 'certifications', run: () => FILES['certs.txt']().forEach(print) },
    skills: {
      help: 'skills by area',
      run: () => skills.forEach((g) => print([{ text: `${g.group.padEnd(16)}`, cls: 'acc' }, g.items.join(' · ')])),
    },
    projects: {
      help: 'notable projects and talks',
      run: () => projects.forEach((p) => {
        print([{ text: `▸ ${p.name}`, cls: 'acc' }]);
        print([{ text: `  ${p.blurb}`, cls: 'dim' }]);
        if (p.link) print(['  ', { text: p.link.label, href: p.link.href }]);
      }),
    },
    blog: {
      help: 'posts on this site',
      run: () => {
        if (!posts.length) return print([{ text: 'No posts yet.', cls: 'dim' }]);
        posts.forEach((p) => print([{ text: `${p.date}  `, cls: 'dim' }, { text: p.title, href: p.href }]));
      },
    },
    'threat-model': {
      help: 'STRIDE view of my career  (threat-model <S|T|R|I|D|E>)',
      run: ([letter]) => {
        const pick = letter?.toUpperCase();
        const list = pick ? stride.filter((s) => s.id === pick) : stride;
        if (!list.length) return print([{ text: 'Usage: threat-model [S|T|R|I|D|E]', cls: 'warn' }]);
        for (const t of list) {
          print([{ text: `[${t.id}] ${t.name}`, cls: 'acc' }, { text: ` → ${t.property}`, cls: 'dim' }]);
          (pick ? t.mitigations : t.mitigations.slice(0, 2)).forEach((m) => print([{ text: '  ✓ ', cls: 'ok' }, `${m.control}: `, { text: m.evidence, cls: 'dim' }]));
        }
        print(['Full model: ', { text: '/threat-model/', href: '/threat-model/' }]);
      },
    },
    arch: {
      help: 'how this site is hosted and secured',
      run: () => {
        [
          ['visitor', 'TLS 1.2+ only, HSTS preload'],
          ['  └─ DNS', 'Route 53 hosted zone, CAA pinned to Amazon'],
          ['  └─ CDN', 'CloudFront + strict security headers + edge function'],
          ['      ├─ /*', 'private S3 bucket, reachable only via Origin Access Control'],
          ['      └─ /api/contact', 'HTTP API (throttled) → Lambda (least-privilege role) → SES'],
          ['infra', 'Terraform, state in a versioned + encrypted S3 bucket with locking'],
          ['ci/cd', 'GitHub Actions → AWS via OIDC, no long-lived keys'],
        ].forEach(([a, b]) => print([{ text: a.padEnd(18), cls: 'acc' }, { text: b, cls: 'dim' }]));
        print(['Diagram: ', { text: '/architecture/', href: '/architecture/' }]);
      },
    },
    resume: {
      help: 'download the PDF resume',
      run: () => {
        print(['Opening ', { text: '/resume.pdf', href: '/resume.pdf' }, ' …']);
        window.open('/resume.pdf', '_blank', 'noopener');
      },
    },
    contact: { help: 'jump to the contact form', run: () => goTo('/#contact') },
    linkedin: {
      help: 'open LinkedIn',
      run: () => { print(['→ ', { text: profile.linkedin, href: profile.linkedin }]); window.open(profile.linkedin, '_blank', 'noopener'); },
    },
    ls: {
      help: 'list files',
      run: () => print([{ text: Object.keys(FILES).filter((f) => !f.startsWith('.')).join('  '), cls: 'acc' }]),
    },
    cat: {
      help: 'print a file  (cat summary.txt)',
      run: ([file]) => {
        if (!file) return print([{ text: 'usage: cat <file>', cls: 'warn' }]);
        const f = FILES[file];
        if (!f) return print([{ text: `cat: ${file}: No such file or directory`, cls: 'err' }]);
        f().forEach(print);
      },
    },
    open: {
      help: 'open a page  (open architecture|threat-model|blog|home)',
      run: ([page]) => {
        const map: Record<string, string> = { home: '/', architecture: '/architecture/', 'threat-model': '/threat-model/', blog: '/blog/' };
        if (!page || !map[page]) return print([{ text: 'usage: open architecture|threat-model|blog|home', cls: 'warn' }]);
        goTo(map[page]);
      },
    },
    history: { help: 'command history', run: () => history.forEach((h, i) => print([{ text: `${String(i + 1).padStart(4)}  `, cls: 'dim' }, h])) },
    clear: { help: 'clear the screen', run: () => out.replaceChildren() },
    exit: { help: 'close the terminal', run: () => dialog.close() },
    sudo: {
      help: '', hidden: true,
      run: () => print([{ text: 'guest is not in the sudoers file. This incident will be reported. ', cls: 'err' }, { text: '(least privilege, as promised)', cls: 'dim' }]),
    },
    'rm': { help: '', hidden: true, run: () => print([{ text: 'rm: read-only file system (immutable deploys ftw)', cls: 'err' }]) },
    nmap: { help: '', hidden: true, run: () => print([{ text: 'PORT    STATE  SERVICE\n443/tcp open   https  (everything else: filtered at the edge)', cls: 'dim' }]) },
  };

  const greet = () => {
    printPre(BANNER);
    print([{ text: 'Cloud security engineer · AWS · Azure · GCP', cls: 'dim' }]);
    print(['Type ', { text: 'help', cls: 'ok' }, ' to list commands, or try ', { text: 'whoami', cls: 'ok' }, ', ', { text: 'experience', cls: 'ok' }, ', ', { text: 'threat-model', cls: 'ok' }, '.']);
    print('');
  };

  const run = (raw: string) => {
    const line = raw.trim();
    print([{ text: 'guest@jasonratcliffe:~$ ', cls: 'dim' }, { text: line, cls: 'cmd' }]);
    if (!line) return;
    history.push(line);
    hIndex = history.length;
    const [name, ...args] = line.split(/\s+/);
    const cmd = commands[name.toLowerCase()];
    if (cmd) cmd.run(args);
    else print([{ text: `command not found: ${name}`, cls: 'err' }, { text: '  – type `help`', cls: 'dim' }]);
    print('');
  };

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    if (!greeted) { greet(); greeted = true; }
    input.focus();
    scrollDown();
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value);
    input.value = '';
    scrollDown();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      hIndex = Math.max(0, hIndex - 1);
      input.value = history[hIndex];
    } else if (e.key === 'ArrowDown' && history.length) {
      e.preventDefault();
      hIndex = Math.min(history.length, hIndex + 1);
      input.value = history[hIndex] ?? '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const [first, ...rest] = input.value.split(' ');
      if (rest.length && first === 'cat') {
        const m = Object.keys(FILES).filter((f) => f.startsWith(rest[0]));
        if (m.length === 1) input.value = `cat ${m[0]}`;
        return;
      }
      const matches = Object.keys(commands).filter((c) => !commands[c].hidden && c.startsWith(first));
      if (matches.length === 1) input.value = `${matches[0]} `;
      else if (matches.length > 1) { print([{ text: matches.join('  '), cls: 'dim' }]); scrollDown(); }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      out.replaceChildren();
    }
  });

  // Keep focus in the prompt when the screen is clicked (but let links work).
  screen.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('a') && !window.getSelection()?.toString()) input.focus();
  });

  document.querySelectorAll('[data-terminal-open]').forEach((b) => b.addEventListener('click', open));
  dialog.querySelector('[data-terminal-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]') && !dialog.open) return;
    e.preventDefault();
    if (dialog.open) dialog.close();
    else open();
  });
}
