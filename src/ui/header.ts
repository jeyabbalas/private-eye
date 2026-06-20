import logoUrl from '../../assets/logo/private_eye_logo.svg?url';
import githubUrl from '../../assets/logo/github.svg?url';

const REPO_URL = 'https://github.com/jeyabbalas/private-eye';

/** The non-intrusive black header band: logo-in-circle, wordmark + tagline,
 *  GitHub link. Build-time constant URLs, so innerHTML is safe here. */
export function buildHeader(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'pe-header';
  header.innerHTML = `
    <div class="pe-logo"><img src="${logoUrl}" alt="" /></div>
    <div class="pe-titles">
      <div class="pe-name">Private Eye</div>
      <div class="pe-tagline">Privacy-preserving optical character recognition</div>
    </div>
    <div class="pe-header-spacer"></div>
    <a class="pe-github" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="View Private Eye on GitHub">
      <img src="${githubUrl}" alt="" width="44" height="44" />
    </a>`;
  return header;
}

export { logoUrl };
