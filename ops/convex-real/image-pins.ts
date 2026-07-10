export type SelfHostedConvexImage = {
  name: 'backend' | 'dashboard';
  repository: string;
  digest: string;
};

export const SELF_HOSTED_CONVEX_IMAGES = [
  {
    name: 'backend',
    repository: 'ghcr.io/get-convex/convex-backend',
    digest: 'sha256:104b8bc70e29b31fa4a57551596090bfc9eedc3d1f27fd4b8cd8d0e782b9b070',
  },
  {
    name: 'dashboard',
    repository: 'ghcr.io/get-convex/convex-dashboard',
    digest: 'sha256:60b04b339d6cd6623057b03e5275329a20011051907ec5e689a38a401cfdc409',
  },
] as const satisfies readonly SelfHostedConvexImage[];

export function pinnedImageReference(image: SelfHostedConvexImage): string {
  return `${image.repository}@${image.digest}`;
}
