export const iconManifest = {
  copy: 'Interface Essential/Select Copy/Copy Paste.svg',
  leakTrace: 'Interface Essential/ID/Fingerprint Scan 1.svg',
  link: 'Interface Essential/Link Unlink/Link Chain.svg',
  package: 'Shipping/Box/Package.svg',
  search: 'Interface Essential/Search/Magnifying Glass.svg',
  store: 'Money Shopping/Building Store/Store 1.svg',
  upload: 'Interface Essential/Upload Download/Upload Tray.svg',
} as const satisfies Record<string, `${string}.svg`>;

export type IconName = keyof typeof iconManifest;
