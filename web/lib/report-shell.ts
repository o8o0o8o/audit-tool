/**
 * Puts the site's own header and footer around a report, with no iframe and no second copy of
 * either: the markup and CSS come from the app's rendered /internal/shell page. Each is placed in a
 * declarative shadow root, so the site CSS and the report CSS cannot touch each other.
 */
interface Shell {
  header: string;
  footer: string;
  css: string;
  fontFaces: string;
}

let cached: { at: number; shell: Shell } | null = null;
const CACHE_MS = process.env.NODE_ENV === 'production' ? 10 * 60_000 : 5_000;

function outer(html: string, tag: string, from: 'first' | 'last'): string {
  const open = from === 'first' ? html.indexOf(`<${tag}`) : html.lastIndexOf(`<${tag}`);
  const close = html.indexOf(`</${tag}>`, open);
  if (open < 0 || close < 0) throw new Error(`shell has no <${tag}>`);
  return html.slice(open, close + tag.length + 3);
}

/** Site CSS made to work inside a shadow root: :root → :host, html/body → the shell wrapper. */
function scopeCss(css: string): string {
  return css
    .replace(/@font-face\s*{[^}]*}/g, '')
    .replace(/:root\b/g, ':host')
    .replace(/(^|[{},\s>+~])(?:html|body)(?=[\s,{.:[>+~])/g, '$1.fr-shell');
}

export async function loadShell(origin: string): Promise<Shell> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.shell;
  const page = await (await fetch(`${origin}/internal/shell`, { cache: 'no-store' })).text();
  const head = page.slice(0, page.indexOf('</head>'));
  const hrefs = [...head.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
    .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
    .filter((h): h is string => !!h);
  const css = (
    await Promise.all(hrefs.map(async (h) => (await fetch(new URL(h, origin), { cache: 'no-store' })).text()))
  ).join('\n');
  const shell = {
    header: outer(page, 'header', 'first'),
    footer: outer(page, 'footer', 'last'),
    css: scopeCss(css),
    // Fonts register only in the document, never inside a shadow root.
    fontFaces: (css.match(/@font-face\s*{[^}]*}/g) ?? []).join('\n'),
  };
  cached = { at: Date.now(), shell };
  return shell;
}

const host = (id: string, css: string, html: string) =>
  `<div id="${id}"><template shadowrootmode="open"><style>${css}</style><div class="fr-shell">${html}</div></template></div>`;

/** Sticky header and the phone menu, which the app does with React, done here with plain DOM. */
const SHELL_SCRIPT = `<script>(function(){
var h=document.getElementById('fr-site-header');if(!h||!h.shadowRoot)return;var r=h.shadowRoot,header=r.querySelector('.header');
function pad(){if(!header)return;var px=header.offsetHeight+'px';document.body.style.paddingTop=px;document.documentElement.style.setProperty('--fr-site-header-h',px)}
function sticky(){if(header)header.classList.toggle('is-sticky',window.scrollY>0)}
addEventListener('scroll',sticky,{passive:true});addEventListener('resize',pad);pad();sticky();
var b=r.querySelector('.hamburger'),n=r.querySelector('.header__nav');
if(b&&n)b.addEventListener('click',function(){var o=!n.classList.contains('is-open');n.classList.toggle('is-open',o);b.classList.toggle('is-active',o);b.setAttribute('aria-expanded',String(o));document.body.style.overflow=o?'hidden':''});
})()</script>`;

/** The report's own wordmark bar and footer give way to the site's (its Export/Share stay). */
const REPORT_TWEAKS =
  '.fr-header-bar .fr-wordmark,footer:has(.fr-footer-inner){display:none!important}.fr-header-bar{justify-content:flex-end}' +
  // The report's sticky parts stop below the site's fixed header.
  '.section-tabs{top:var(--fr-site-header-h,0px)!important}html{scroll-padding-top:calc(var(--fr-site-header-h,0px) + 64px)}';

export function wrapReport(report: string, shell: Shell, baseHref: string): string {
  const head = `<base href="${baseHref}"><style>${shell.fontFaces}\n${REPORT_TWEAKS}</style>`;
  let html = report.includes('</head>') ? report.replace('</head>', `${head}</head>`) : head + report;
  const bodyOpen = html.match(/<body[^>]*>/);
  if (bodyOpen) html = html.replace(bodyOpen[0], `${bodyOpen[0]}${host('fr-site-header', shell.css, shell.header)}`);
  const end = html.lastIndexOf('</body>');
  const footer = `${host('fr-site-footer', shell.css, shell.footer)}${SHELL_SCRIPT}`;
  return end >= 0 ? html.slice(0, end) + footer + html.slice(end) : html + footer;
}
