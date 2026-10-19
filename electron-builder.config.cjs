// electron-builder configuration for the desktop releases.
// Windows: NSIS installer (x64, arm64) and a portable .exe (x64).
// macOS: universal (Apple silicon + Intel) .dmg and .zip, ad-hoc signed.
// Linux: AppImage and .deb for x64, arm64 (Raspberry Pi OS 64-bit, ChromeOS Linux on ARM) and
// armv7l (Raspberry Pi OS 32-bit).
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.socrtwo.quillfolio',
  productName: 'QuillFolio',
  copyright: 'QuillFolio contributors, MIT License',
  directories: { app: 'build/desktop-app', output: 'release', buildResources: 'resources' },
  artifactName: 'QuillFolio-${version}-${os}-${arch}.${ext}',
  asar: true,
  // Everything the app needs is bundled into dist/ by Vite; ship no node_modules.
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!**/node_modules/**'],
  icon: 'resources/icon-1024.png',
  fileAssociations: [
    { ext: 'pdf', name: 'PDF Document', role: 'Editor', mimeType: 'application/pdf' },
    { ext: 'fdf', name: 'PDF Form Data', role: 'Viewer', mimeType: 'application/vnd.fdf' },
    { ext: 'xfdf', name: 'XFDF Form and Comment Data', role: 'Viewer', mimeType: 'application/vnd.adobe.xfdf' },
    { ext: 'qfr', name: 'QuillFolio Review Package', role: 'Editor', mimeType: 'application/x-quillfolio-review' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'portable', arch: ['x64'] }],
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: 'QuillFolio-${version}-windows-${arch}-setup.${ext}' },
  portable: { artifactName: 'QuillFolio-${version}-windows-portable.${ext}' },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    extendInfo: { CFBundleDisplayName: 'QuillFolio' },
    // Ad-hoc signature: runs on Apple silicon without a paid Developer ID, but is not notarized,
    // so Gatekeeper asks once (docs/INSTALL.md). Hardened runtime would reject Electron's own signature.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64', 'armv7l'] }, { target: 'deb', arch: ['x64', 'arm64', 'armv7l'] }],
    category: 'Office;Viewer;Graphics',
    synopsis: 'PDF viewer and editor with forms, signing, OCR and repair',
    description: 'QuillFolio is an open-source PDF app: view, comment, edit, fill forms, sign, recognize text in scans and repair damaged files. Every feature is a command you can put on the ribbon, the Quick Access Bar, a shortcut or a macro.',
    maintainer: 'socrtwo <socrtwo@users.noreply.github.com>',
    executableName: 'quillfolio',
    syncDesktopName: true,
  },
  publish: null,
};
