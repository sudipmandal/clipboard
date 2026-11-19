// Display-only link helpers: a small ↗ icon after every web address so it opens in a new tab.
// The stored entry is never changed, so copying an entry still gives exactly what was pasted.

// Common prose separators are not part of a URL. Keep URL path/query punctuation such as
// `?`, `&`, `=`, parentheses and brackets, but split addresses joined by pipes or backslashes.
const URL_CANDIDATE = /\bhttps?:\/\/[^\s<>"'`|\\]+/gi;
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

function count(text, char) {
  return text.split(char).length - 1;
}

// Drops trailing punctuation that belongs to the sentence, and closing brackets without an opening one:
// "(see https://a.example/x)." -> "https://a.example/x", but "https://en.wikipedia.org/wiki/A_(B)" is kept whole.
function trimUrl(candidate) {
  let url = candidate.replace(/[.,;:!?]+$/, '');
  while (CLOSERS[url.slice(-1)]) {
    const close = url.slice(-1);
    if (count(url, CLOSERS[close]) >= count(url, close)) break;
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url;
}

export function isWebUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Web addresses in plain text: [{ start, end, url }]
export function findUrls(text) {
  const found = [];
  for (const match of String(text).matchAll(URL_CANDIDATE)) {
    const url = trimUrl(match[0]);
    if (isWebUrl(url)) found.push({ start: match.index, end: match.index + url.length, url });
  }
  return found;
}

function openIcon(doc, url) {
  const link = doc.createElement('a');
  link.className = 'link-open';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = `Open ${url} in a new tab`;
  link.setAttribute('aria-label', 'Open link in a new tab');
  const icon = doc.createElement('i');
  icon.className = 'bi bi-box-arrow-up-right';
  icon.setAttribute('aria-hidden', 'true');
  link.appendChild(icon);
  return link;
}

// Adds the icons inside a parsed (already sanitized) document.
export function addLinkIcons(doc) {
  // Existing links (rich pastes): open in a new tab so Clippy is never left, plus the same icon.
  for (const anchor of [...doc.body.querySelectorAll('a[href]')]) {
    const href = anchor.getAttribute('href');
    if (!isWebUrl(href)) continue;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    const icon = openIcon(doc, href);
    anchor.after(icon);
    gluePunctuation(doc, icon);
  }
  // Plain-text addresses: the text stays as it is, the icon is inserted right after it.
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('a')) textNodes.push(node);
  }
  for (const node of textNodes) {
    const urls = findUrls(node.data);
    for (const { end, url } of urls.reverse()) {
      // [text … addres][s ↗ .][rest]: the last character of the address, the icon and any punctuation right
      // after it share a no-wrap span, so the icon never starts a line or pushes the punctuation onto the next one.
      const lastChar = node.splitText(end - 1);
      const after = lastChar.splitText(1);
      const punctuation = /^[.,;:!?)\]}'"»]+/.exec(after.data)?.[0] || '';
      if (punctuation) after.splitText(punctuation.length); // `after` keeps only the punctuation
      const tail = doc.createElement('span');
      tail.className = 'link-tail';
      lastChar.before(tail);
      tail.append(lastChar, openIcon(doc, url));
      if (punctuation) tail.append(after);
    }
  }
  return doc;
}

// Rich-paste links: keep the icon and the punctuation right after it on the same line.
function gluePunctuation(doc, icon) {
  const next = icon.nextSibling;
  if (!next || next.nodeType !== 3) return;
  const punctuation = /^[.,;:!?)\]}'"»]+/.exec(next.data)?.[0];
  if (!punctuation) return;
  next.splitText(punctuation.length); // `next` keeps only the punctuation
  const tail = doc.createElement('span');
  tail.className = 'link-tail';
  icon.before(tail);
  tail.append(icon, next);
}
