// Remove the build output directory so renamed or deleted modules cannot linger in
// `out/` and get published. Zero-dependency and cross-platform by design.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'out');
fs.rmSync(out, { recursive: true, force: true });
