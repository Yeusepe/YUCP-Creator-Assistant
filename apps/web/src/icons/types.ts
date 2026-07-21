export type GeneratedIconPath = Readonly<{
  clipRule?: 'evenodd' | 'inherit' | 'nonzero';
  d: string;
  fillOpacity?: string;
  fillRule?: 'evenodd' | 'inherit' | 'nonzero';
  strokeWidth?: string;
}>;

export type GeneratedIcon = Readonly<{
  attribution: string;
  paths: ReadonlyArray<GeneratedIconPath>;
  viewBox: string;
}>;
