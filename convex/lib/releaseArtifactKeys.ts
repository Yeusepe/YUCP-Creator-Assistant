export const RELEASE_ARTIFACT_KEYS = {
  couplingRuntime: 'coupling-runtime',
  couplingRuntimePackage: 'coupling-runtime-package',
} as const;

export const RELEASE_CHANNELS = {
  stable: 'stable',
} as const;

export const RELEASE_PLATFORMS = {
  winX64: 'win-x64',
  linuxX64: 'linux-x64',
  linuxArm64: 'linux-arm64',
  darwinX64: 'darwin-x64',
  darwinArm64: 'darwin-arm64',
} as const;
