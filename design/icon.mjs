// Source of the extension's icon pack. `node design/build-icons.mjs` renders the PNGs.
// size: output px; pad: transparent padding px; simple: 16px variant (one person).
export function iconSvg({ size = 128, pad = 16, simple = false } = {}) {
  const s = size - pad * 2;              // artwork box
  const k = s / 100;                     // artwork is drawn on a 100x100 grid
  const g = (v) => +(v * k + pad).toFixed(2);
  const r = +(s * 0.27).toFixed(2);
  const id = "g" + size + (simple ? "s" : "");
  const people = simple
    ? `<circle cx="${g(44)}" cy="${g(37)}" r="${16 * k}" fill="#fff"/>
       <path d="M${g(13)} ${g(92)} C${g(13)} ${g(70)} ${g(27)} ${g(57)} ${g(44)} ${g(57)} C${g(61)} ${g(57)} ${g(75)} ${g(70)} ${g(75)} ${g(92)} Z" fill="#fff"/>`
    : `<circle cx="${g(36)}" cy="${g(33)}" r="${11 * k}" fill="#fff" fill-opacity=".5"/>
       <path d="M${g(15)} ${g(72)} C${g(15)} ${g(58)} ${g(24)} ${g(49)} ${g(36)} ${g(49)} C${g(48)} ${g(49)} ${g(57)} ${g(58)} ${g(57)} ${g(72)} Z" fill="#fff" fill-opacity=".5"/>
       <circle cx="${g(52)}" cy="${g(41)}" r="${14 * k}" fill="#fff"/>
       <path d="M${g(24)} ${g(92)} C${g(24)} ${g(72)} ${g(36)} ${g(60)} ${g(52)} ${g(60)} C${g(68)} ${g(60)} ${g(80)} ${g(72)} ${g(80)} ${g(92)} Z" fill="#fff"/>`;
  const bx = simple ? 74 : 76, by = simple ? 74 : 75, br = simple ? 19 : 17;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3B82F6"/><stop offset=".55" stop-color="#4F46E5"/><stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
    <linearGradient id="${id}sh" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}bd" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF6B6B"/><stop offset="1" stop-color="#E11D48"/>
    </linearGradient>
    <clipPath id="${id}clip"><rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${r}"/></clipPath>
  </defs>
  <rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${r}" fill="url(#${id}bg)"/>
  <g clip-path="url(#${id}clip)">
    ${people}
    <rect x="${pad}" y="${pad}" width="${s}" height="${s / 2}" fill="url(#${id}sh)"/>
  </g>
  <circle cx="${g(bx)}" cy="${g(by)}" r="${(br + (simple ? 4 : 4.5)) * k}" fill="#fff"/>
  <circle cx="${g(bx)}" cy="${g(by)}" r="${br * k}" fill="url(#${id}bd)"/>
  <rect x="${g(bx - br * 0.55)}" y="${g(by - (simple ? 3.6 : 3))}" width="${br * 1.1 * k}" height="${(simple ? 7.2 : 6) * k}" rx="${(simple ? 3.6 : 3) * k}" fill="#fff"/>
</svg>`;
}
