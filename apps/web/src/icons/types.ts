export type GeneratedIconPath = Readonly<{
  clipRule?: 'evenodd' | 'inherit' | 'nonzero';
  d: string;
  fillRule?: 'evenodd' | 'inherit' | 'nonzero';
  strokeWidth?: string;
  tone: 'primary' | 'secondary';
}>;

export type GeneratedIcon = Readonly<{
  attribution: string;
  paths: ReadonlyArray<GeneratedIconPath>;
  viewBox: string;
}>;
