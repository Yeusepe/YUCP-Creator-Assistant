import type { CSSProperties, SVGProps } from 'react';
import { generatedIcons } from '@/icons/generated';
import type { IconName } from '@/icons/manifest';

type IconStyle = CSSProperties & {
  '--icon-theme-accent-color'?: string;
};

export interface IconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    'aria-label' | 'children' | 'dangerouslySetInnerHTML' | 'height' | 'name' | 'width'
  > {
  accentColor?: string;
  colorOnInteraction?: boolean;
  label?: string;
  name: IconName;
  size?: number | string;
}

export function Icon({
  accentColor,
  className,
  colorOnInteraction = true,
  label,
  name,
  size = 20,
  style,
  ...props
}: IconProps) {
  const icon = generatedIcons[name];
  if (!icon) {
    throw new Error(`Unknown icon name: ${name}`);
  }

  const accessibleLabel = label?.trim() || undefined;
  const iconStyle: IconStyle = {
    ...style,
    ...(accentColor ? { '--icon-theme-accent-color': accentColor } : {}),
  };

  return (
    <svg
      {...props}
      aria-hidden={accessibleLabel ? undefined : true}
      aria-label={accessibleLabel}
      className={className ? `yucp-icon ${className}` : 'yucp-icon'}
      data-icon-color={colorOnInteraction ? 'interaction' : 'always'}
      focusable="false"
      height={size}
      role={accessibleLabel ? 'img' : undefined}
      style={iconStyle}
      viewBox={icon.viewBox}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <desc>{icon.attribution}</desc>
      {icon.paths.map((path) => (
        <path
          clipRule={path.clipRule}
          data-icon-layer={path.tone}
          d={path.d}
          fill={
            path.tone === 'primary'
              ? 'var(--icon-render-primary-color)'
              : 'var(--icon-render-accent-color)'
          }
          fillRule={path.fillRule}
          key={path.d}
          strokeWidth={path.strokeWidth}
        />
      ))}
    </svg>
  );
}
