import logoUrl from '../../assets/logo/private_eye_logo.svg?url';
import githubUrl from '../../assets/logo/github.svg?url';

const REPO_URL = 'https://github.com/jeyabbalas/private-eye';

/** Fill `el` with the full landing band: logo-in-circle, wordmark + tagline,
 *  GitHub link. Build-time constant URLs, so innerHTML is safe here. */
export function fillLandingBand(el: HTMLElement): void {
  el.innerHTML = `
    <div class="pe-logo"><img src="${logoUrl}" alt="" /></div>
    <div class="pe-titles">
      <div class="pe-name">Private Eye</div>
      <div class="pe-tagline">Privacy-preserving optical character recognition</div>
    </div>
    <div class="pe-header-spacer"></div>`;
  el.appendChild(githubLink(44));
}

/** The non-intrusive black header band (used standalone by the capability gate;
 *  the workspace fills its own bar element with the same content). */
export function buildHeader(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'pe-header';
  fillLandingBand(header);
  return header;
}

/** GitHub repo link at a given icon size (44 on the landing band, 30 in the
 *  compact work top bar). */
export function githubLink(px: number): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'pe-github';
  a.href = REPO_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'View Private Eye on GitHub');
  a.innerHTML = `<img src="${githubUrl}" alt="" width="${px}" height="${px}" />`;
  return a;
}

export { logoUrl };
