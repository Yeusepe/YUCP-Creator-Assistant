import { BACKSTAGE_VPM_DELIVERY_MODES, type YucpAliasPackageContract } from '@yucp/shared';

export type BackstageImporterDelivery = {
  packageInstallStrategy: YucpAliasPackageContract['installStrategy'];
  repoCatalogDeliveryMode: (typeof BACKSTAGE_VPM_DELIVERY_MODES)['repoTokenVpm'];
  repoCatalogReadOnly: true;
};

export function buildBackstageImporterDelivery(
  aliasContract: YucpAliasPackageContract | undefined
): BackstageImporterDelivery | undefined {
  if (!aliasContract) {
    return undefined;
  }

  return {
    packageInstallStrategy: aliasContract.installStrategy,
    repoCatalogDeliveryMode: BACKSTAGE_VPM_DELIVERY_MODES.repoTokenVpm,
    repoCatalogReadOnly: true,
  };
}
