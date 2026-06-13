import { describe, expect, test } from 'bun:test';

describe('backstage-deliverable-remediation', () => {
  test('flags stale raw artifacts even when the deliverable hash is already current', async () => {
    const module = (await import('./backstage-deliverable-remediation')) as {
      computeArtifactRemediationPlan?: (input: {
        currentDeliverableSha256?: string;
        nextDeliverableSha256: string;
        rawArtifact: {
          sha256: string;
          contentType: string;
          deliveryName: string;
        } | null;
        rawPayloadSha256: string;
        rawPayloadContentType: string;
        rawPayloadDeliveryName: string;
      }) => {
        deliverableChanged: boolean;
        rawArtifactNeedsReplace: boolean;
        deliverableNeedsRepublish: boolean;
        requiresRepair: boolean;
      };
    };

    expect(
      module.computeArtifactRemediationPlan?.({
        currentDeliverableSha256: 'same-wrapper-sha',
        nextDeliverableSha256: 'same-wrapper-sha',
        rawArtifact: {
          sha256: 'stale-wrapper-sha',
          contentType: 'application/zip',
          deliveryName: 'vrc-get-com.yucp.example-1.2.3.zip',
        },
        rawPayloadSha256: 'raw-unitypackage-sha',
        rawPayloadContentType: 'application/octet-stream',
        rawPayloadDeliveryName: 'com.yucp.example-1.2.3.unitypackage',
      })
    ).toEqual({
      deliverableChanged: false,
      rawArtifactNeedsReplace: true,
      deliverableNeedsRepublish: true,
      requiresRepair: true,
    });
  });
});
