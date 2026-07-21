import type { SVGProps } from 'react';
import { generatedIcons } from '@/icons/generated';
import type { IconName } from '@/icons/manifest';

export interface IconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    'aria-label' | 'children' | 'dangerouslySetInnerHTML' | 'height' | 'name' | 'width'
  > {
  label?: string;
  name: IconName;
  size?: number | string;
}

export function Icon({ className, label, name, size = 20, ...props }: IconProps) {
  const icon = generatedIcons[name];
  if (!icon) {
    throw new Error(`Unknown icon name: ${name}`);
  }

  const accessibleLabel = label?.trim() || undefined;

  return (
    <svg
      {...props}
      aria-hidden={accessibleLabel ? undefined : true}
      aria-label={accessibleLabel}
      className={className}
      focusable="false"
      height={size}
      role={accessibleLabel ? 'img' : undefined}
      viewBox={icon.viewBox}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <desc>{icon.attribution}</desc>
      {icon.paths.map((path) => (
        <path
          clipRule={path.clipRule}
          d={path.d}
          fill="currentColor"
          fillOpacity={path.fillOpacity}
          fillRule={path.fillRule}
          key={path.d}
          strokeWidth={path.strokeWidth}
        />
      ))}
    </svg>
  );
}
