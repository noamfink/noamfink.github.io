// Builds the static site into dist/.
//   Content:  projects/*.md (one per project, ordered by filename), site.json
//   Sketches: sketches/<slug>.svg (home page tiles)
//   Photos:   images/<slug>/* (originals; WebP sizes are generated here)
// Run: npm run build
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Marked } from 'marked';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const OUT = path.join(ROOT, 'dist');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.json'), 'utf8'));
const WIDTHS = [640, 1024, 1600, 2400];
const warnings = [];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isPlaceholder = v => !v || /^\[.*\]$/.test(v);
// Version stamp for CSS/JS links, so browsers fetch a new copy as soon as the file changes.
const ver = f => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'static', f))).digest('hex').slice(0, 8);

// ---------- content ----------
function parseProject(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(m[1].split('\n').filter(Boolean).map(l => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const todos = [...m[2].matchAll(/<!--\s*TODO:?\s*([\s\S]*?)-->/g)].map(t => t[1].trim());
  return { ...meta, body: m[2], todos };
}

const projects = fs.readdirSync(path.join(ROOT, 'projects')).filter(f => f.endsWith('.md')).sort()
  .map(f => parseProject(path.join(ROOT, 'projects', f)));

// ---------- images ----------
const media = new Map(); // source path -> { srcset, src, width, height } or { video }

async function processImage(rel) {
  if (media.has(rel)) return media.get(rel);
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { warnings.push(`Missing image: ${rel}`); media.set(rel, null); return null; }
  if (rel.endsWith('.mp4')) {
    const outRel = 'media/' + rel.replace(/^images\//, '');
    copy(src, path.join(OUT, outRel));
    const poster = path.join(path.dirname(rel), 'poster.jpg');
    let posterRel = null;
    if (fs.existsSync(path.join(ROOT, poster))) {
      posterRel = 'media/' + poster.replace(/\\/g, '/').replace(/^images\//, '');
      copy(path.join(ROOT, poster), path.join(OUT, posterRel));
    }
    const info = { video: '/' + outRel, poster: posterRel && '/' + posterRel };
    media.set(rel, info);
    return info;
  }
  const meta = await sharp(src).metadata();
  const base = rel.replace(/^images\//, '').replace(/\.\w+$/, '');
  const widths = [...new Set(WIDTHS.map(w => Math.min(w, meta.width)))];
  const set = [];
  for (const w of widths) {
    const outRel = `img/${base}-${w}.webp`;
    const out = path.join(OUT, outRel);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await sharp(src).resize({ width: w }).webp({ quality: 78, effort: 5 }).toFile(out);
    }
    set.push(`/${outRel} ${w}w`);
  }
  if (meta.width < 1200) warnings.push(`Low-res (${meta.width}px wide): ${rel}`);
  const info = {
    src: set[Math.min(1, set.length - 1)].split(' ')[0],
    srcset: set.join(', '),
    width: meta.width,
    height: meta.height,
  };
  media.set(rel, info);
  return info;
}

async function ogImage(rel, name) {
  const out = path.join(OUT, 'og', name + '.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(path.join(ROOT, rel)).flatten({ background: '#F6F6F4' })
    .resize(1200, 630, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toFile(out);
  return `/og/${name}.jpg`;
}

async function siteOgImage(heroRel) {
  const out = path.join(OUT, 'og', 'site.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const photo = await sharp(path.join(ROOT, heroRel)).flatten({ background: '#F6F6F4' })
    .resize(520, 630, { fit: 'cover', position: 'attention' }).toBuffer();
  // Wrap the hero line to fit the left side of the preview image.
  const lines = [];
  for (const word of site.hero.split(' ')) {
    if (lines.length && (lines.at(-1) + ' ' + word).length <= 17) lines[lines.length - 1] += ' ' + word;
    else lines.push(word);
  }
  const top = 372 - (lines.length - 1) * 36;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#F6F6F4"/>
    <text x="64" y="104" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="28" fill="#6E726F">${esc(site.name)} · Industrial Design</text>
    <text font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="60" fill="#1B1D1C" letter-spacing="-1.5">
      ${lines.map((l, i) => `<tspan x="60" y="${top + i * 72}">${esc(l)}</tspan>`).join('')}</text>
    <circle cx="70" cy="542" r="6" fill="#4F6B5C"/>
    <text x="88" y="551" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" fill="#4F6B5C">Open to internships and full-time roles</text>
  </svg>`;
  await sharp(Buffer.from(svg)).composite([{ input: photo, left: 680, top: 0 }]).jpeg({ quality: 85 }).toFile(out);
  return '/og/site.jpg';
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.existsSync(to) || fs.statSync(to).mtimeMs < fs.statSync(from).mtimeMs) fs.copyFileSync(from, to);
}

// ---------- markdown ----------
const SIZES = '(min-width: 1264px) 1200px, calc(100vw - 32px)';
let firstImage = true;

function picture(info, alt, { eager = false, sizes = SIZES } = {}) {
  return `<img src="${info.src}" srcset="${info.srcset}" sizes="${sizes}" width="${info.width}" height="${info.height}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
}

const md = new Marked({
  renderer: {
    paragraph(token) {
      if (token.tokens.length === 1 && token.tokens[0].type === 'image') return this.parser.parseInline(token.tokens);
      return false;
    },
    image({ href, title, text }) {
      const info = media.get(href);
      if (!info) return '';
      const caption = title ? `<figcaption>${esc(title)}</figcaption>` : '';
      if (info.video) {
        return `<figure class="figure figure--video"><video controls playsinline preload="none"${info.poster ? ` poster="${info.poster}"` : ''} aria-label="${esc(text)}"><source src="${info.video}" type="video/mp4"></video>${caption}</figure>\n`;
      }
      const html = `<figure class="figure">${picture(info, text, { eager: firstImage })}${caption}</figure>\n`;
      firstImage = false;
      return html;
    },
    html({ text }) {
      return /^\s*<!--/.test(text) ? '' : false;
    },
  },
});

// ---------- templates ----------
const fontHref = 'https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500&display=swap';

function layout({ title, description, url, image, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${site.url}${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${site.url}${url}">
<meta property="og:image" content="${site.url}${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#F6F6F4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#2B2624" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontHref}">
<link rel="stylesheet" href="/styles.css?v=${ver('styles.css')}">
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-header wrap">
  <a class="brand" href="/">${esc(site.name)}</a>
  <nav aria-label="Main">
    <a href="/#work">Work</a>
    <a href="/#about">About</a>
    <a href="/#contact">Contact</a>
    <a href="${site.resume}">Resume</a>
    <button class="theme-toggle" type="button" aria-label="Switch colour theme"><span aria-hidden="true"></span></button>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer wrap">
  <p>© ${new Date().getFullYear()} ${esc(site.name)}</p>
  <p class="footer-links">${contactLinks()}</p>
</footer>
<script src="/main.js?v=${ver('main.js')}" defer></script>
</body>
</html>
`;
}

function contactLinks() {
  return [
    `<a href="mailto:${esc(site.email)}">Email</a>`,
    `<a href="${esc(site.linkedin)}" rel="me noopener">LinkedIn</a>`,
    `<a href="${site.resume}">Resume</a>`,
  ].join('');
}

function sketch(slug) {
  const file = path.join(ROOT, 'sketches', slug + '.svg');
  if (!fs.existsSync(file)) { warnings.push(`Missing sketch: sketches/${slug}.svg`); return ''; }
  return fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ').trim();
}

// Tile backgrounds: a mix of light, cool (greyish) browns, used in this order and repeated
// if there are more projects than colours. Neighbours alternate paler/deeper.
// Each pair is [light mode, dark mode].
const BROWNS = [
  ['#E5E0DC', '#3A3431'], // pale taupe
  ['#CCC4BF', '#4A423E'], // ash brown
  ['#DDD7D3', '#413A37'], // mushroom
  ['#C5BDB8', '#504743'], // smoky taupe
  ['#EAE6E3', '#363030'], // light greige
  ['#D2C9C6', '#4B4240'], // rose taupe
  ['#D9D3CD', '#443D39'], // stone
  ['#BFB7B2', '#564C48'], // cool mocha
  ['#E1DAD7', '#3E3735'], // pale ash
];

function homePage(portrait, ogSite) {
  const tiles = projects.map((p, i) => {
    const [light, dark] = BROWNS[i % BROWNS.length];
    return `
    <li>
      <a class="tile" href="/work/${p.slug}/" style="--tint-l: ${light}; --tint-d: ${dark}">
        <span class="tile__art">${sketch(p.slug)}</span>
        <span class="tile__meta"><span class="tile__num">${String(i + 1).padStart(2, '0')}</span><span class="tile__title">${esc(p.title)}</span></span>
      </a>
    </li>`;
  }).join('');

  const facts = site.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const body = `
<section class="hero wrap">
  <h1>${esc(site.hero)}</h1>
  <p class="availability"><span class="dot" aria-hidden="true"></span>${esc(site.availability)}</p>
</section>

<section id="work" class="work wrap" aria-labelledby="work-title">
  <h2 id="work-title" class="label">Selected work</h2>
  <ul class="grid" role="list">${tiles}
  </ul>
</section>

<section id="about" class="about wrap" aria-labelledby="about-title">
  <h2 id="about-title" class="label">About</h2>
  <div class="about__grid">
    <div class="about__photo">${portrait ? picture(portrait, `Portrait of ${site.name}`, { sizes: '(min-width: 900px) 360px, calc(100vw - 32px)' }) : ''}</div>
    <div class="about__text">
      <p class="lead">${esc(site.aboutLead)}</p>
      ${site.about.map(p => `<p>${esc(p)}</p>`).join('\n      ')}
      <dl class="facts">${facts}</dl>
    </div>
  </div>
</section>

<section id="contact" class="contact wrap" aria-labelledby="contact-title">
  <h2 id="contact-title" class="label">Contact</h2>
  <p class="contact__lead">${esc(site.availability)} Let's talk.</p>
  <ul class="contact__list" role="list">
    <li><span>Email</span><a href="mailto:${esc(site.email)}">${esc(site.email)}</a></li>
    <li><span>LinkedIn</span><a href="${esc(site.linkedin)}" rel="me noopener">${esc(site.linkedin.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>
    <li><span>Resume</span><a href="${site.resume}">Download PDF</a></li>
  </ul>
</section>`;
  return layout({
    title: `${site.name}, Industrial Designer`,
    description: site.description,
    url: '/',
    image: ogSite,
    body,
    bodyClass: 'home',
  });
}

function projectPage(p, i, og) {
  firstImage = true;
  const prev = projects[(i - 1 + projects.length) % projects.length];
  const next = projects[(i + 1) % projects.length];
  const meta = [p.credits, p.award && `<span class="award">${esc(p.award)}</span>`].filter(Boolean);
  const body = `
<article class="project wrap">
  <header class="project__header">
    <a class="back" href="/#work">← All work</a>
    <h1>${esc(p.title)}</h1>
    <p class="summary">${esc(p.summary)}</p>
    ${meta.length ? `<p class="project__meta">${meta.map(m => m.startsWith('<') ? m : esc(m)).join('<span aria-hidden="true"> · </span>')}</p>` : ''}
  </header>
  <div class="project__body">
${md.parse(p.body)}
  </div>
</article>
<nav class="pager wrap" aria-label="More projects">
  <a class="pager__prev" href="/work/${prev.slug}/" rel="prev"><span class="label">Previous</span><span class="pager__title">${esc(prev.title)}</span></a>
  <a class="pager__next" href="/work/${next.slug}/" rel="next"><span class="label">Next</span><span class="pager__title">${esc(next.title)}</span></a>
</nav>`;
  return layout({
    title: `${p.title} | ${site.name}`,
    description: p.summary,
    url: `/work/${p.slug}/`,
    image: og,
    body,
    bodyClass: 'is-project',
  });
}

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------- build ----------
fs.mkdirSync(OUT, { recursive: true });
for (const f of ['styles.css', 'main.js', 'favicon.svg', 'robots.txt']) copy(path.join(ROOT, 'static', f), path.join(OUT, f));
if (fs.existsSync(path.join(ROOT, 'resume.pdf'))) copy(path.join(ROOT, 'resume.pdf'), path.join(OUT, 'resume.pdf'));
else warnings.push('resume.pdf not added yet (the Resume links will 404 until it is)');
if (isPlaceholder(site.email)) warnings.push('site.json: email is still a placeholder');
if (isPlaceholder(site.linkedin)) warnings.push('site.json: linkedin is still a placeholder');

for (const p of projects) {
  for (const [, href] of p.body.matchAll(/!\[[^\]]*\]\(([^\s)]+)/g)) await processImage(href);
}
const portrait = await (async () => {
  const src = path.join(ROOT, 'images/about-me/portrait.jpg');
  return fs.existsSync(src) ? processImage('images/about-me/portrait.jpg') : null;
})();

const ogSite = await siteOgImage('images/soma/03.png');
write('index.html', homePage(portrait, ogSite));
for (const [i, p] of projects.entries()) {
  const og = await ogImage(p.cover, p.slug);
  write(`work/${p.slug}/index.html`, projectPage(p, i, og));
  for (const t of p.todos) warnings.push(`TODO ${p.slug}: ${t}`);
}
write('404.html', layout({
  title: `Page not found | ${site.name}`,
  description: site.description,
  url: '/404.html',
  image: ogSite,
  body: `<section class="hero wrap"><h1>This page wandered off.</h1><p class="availability"><a href="/">Back to all work</a></p></section>`,
}));
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/', ...projects.map(p => `/work/${p.slug}/`)].map(u => `  <url><loc>${site.url}${u}</loc></url>`).join('\n')}
</urlset>
`);

console.log(`Built ${projects.length} projects into dist/`);
if (warnings.length) console.log('\nTo fix before sending:\n- ' + warnings.join('\n- '));
