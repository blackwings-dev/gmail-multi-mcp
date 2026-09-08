/**
 * The project icon, as a favicon for the local OAuth callback page.
 *
 * That page is the only web surface this server has: the tab a user lands on
 * after granting consent. It is worth a mark rather than a blank sheet.
 *
 * This is the geometry of `assets/icono-mcp-google-sin-texto.svg` and nothing
 * else. The file in `assets/` is the master and carries a C2PA provenance
 * manifest, which is 8.4 KB of the 8.7 KB it weighs — right for an asset that
 * travels on its own, wrong for something inlined into every response. The
 * drawing itself is 945 bytes: a rounded square, four arcs and four dots.
 *
 * Keep the two in step. If the master changes, re-copy the geometry.
 */

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">\
<rect x="8" y="8" width="224" height="224" rx="52" fill="#111111"/>\
<path d="M 192.9 107.2 A 74 74 0 0 0 132.85 47.1" fill="none" stroke="#FFFFFF" stroke-width="13" transform="rotate(0 120 120)"/>\
<path d="M 192.9 107.2 A 74 74 0 0 0 132.85 47.1" fill="none" stroke="#FFFFFF" stroke-width="13" transform="rotate(90 120 120)"/>\
<path d="M 192.9 107.2 A 74 74 0 0 0 132.85 47.1" fill="none" stroke="#FFFFFF" stroke-width="13" transform="rotate(180 120 120)"/>\
<path d="M 192.9 107.2 A 74 74 0 0 0 132.85 47.1" fill="none" stroke="#FFFFFF" stroke-width="13" transform="rotate(270 120 120)"/>\
<circle cx="120" cy="46" r="14" fill="#4285F4"/>\
<circle cx="194" cy="120" r="14" fill="#EA4335"/>\
<circle cx="120" cy="194" r="14" fill="#FBBC04"/>\
<circle cx="46" cy="120" r="14" fill="#34A853"/>\
</svg>`;

/**
 * A `data:` URI, encoded rather than hand-escaped.
 *
 * The `#` of every colour would otherwise start a URL fragment and cut the
 * image off at the first one, leaving a favicon that is a black square in some
 * browsers and nothing at all in others.
 */
export const FAVICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;
