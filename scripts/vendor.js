// Copies the third-party libraries from node_modules into vendor/ so the app
// never loads code from a CDN. Run after changing a version in package.json.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const files = {
  'vue/dist/vue.esm-browser.prod.js': 'vue.esm-browser.prod.js',
  'marked/lib/marked.esm.js': 'marked.esm.js',
  'dompurify/dist/purify.es.mjs': 'purify.es.mjs',
  'leaflet/dist/leaflet-src.esm.js': 'leaflet/leaflet-src.esm.js',
  'leaflet/dist/leaflet.css': 'leaflet/leaflet.css',
  'leaflet/dist/images': 'leaflet/images',
  'bootstrap-icons/font/bootstrap-icons.min.css': 'bootstrap-icons/bootstrap-icons.min.css',
  'bootstrap-icons/font/fonts': 'bootstrap-icons/fonts',
  // Loaded only when scanning a QR code on browsers without BarcodeDetector.
  'jsqr/dist/jsQR.js': 'jsQR.js',
  // Loaded only when sharing an RV as a PDF.
  'jspdf/dist/jspdf.umd.min.js': 'jspdf.umd.min.js'
};

rmSync('vendor', { recursive: true, force: true });
for (const [from, to] of Object.entries(files)) {
  const source = `node_modules/${from}`;
  const target = `vendor/${to}`;
  mkdirSync(target.replace(/\/[^/]+$/, ''), { recursive: true });
  if (/\.(js|mjs|css)$/.test(to)) {
    const text = readFileSync(source, 'utf8')
      // The source maps aren't copied.
      .replace(/\n?\/[/*][#@] sourceMappingURL=\S+(?: \*\/)?/g, '')
      // The service worker caches the fonts by their plain URLs.
      .replace(/(fonts\/bootstrap-icons\.woff2?)\?[0-9a-f]+/g, '$1');
    writeFileSync(target, text);
  } else {
    cpSync(source, target, { recursive: true });
  }
}
console.log('Copied libraries to vendor/.');
