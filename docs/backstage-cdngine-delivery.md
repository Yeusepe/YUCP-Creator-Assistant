# Backstage CDNgine Delivery

Backstage package releases use CDNgine for durable source storage and delivery artifact distribution.

The source upload and delivery publication phases have different lifecycle guarantees:

- `cdngineSource` records identify canonical upload evidence. They may be returned after CDNgine accepts upload completion.
- `cdngineDelivery` records identify browser-installable delivery artifacts. They must only be persisted after CDNgine reports the immutable version as `published`.

This follows the CDNgine upstream public upload workflow in `E:\GitDevelopment\Development\antiwork\cdngine\contracts\arazzo\public-upload.arazzo.yaml`, which completes an upload session and then polls `GET /v1/assets/{assetId}/versions/{versionId}` until publication is visible. Delivery authorization uses `POST /v1/assets/{assetId}/versions/{versionId}/deliveries/{deliveryScopeId}/authorize` from `E:\GitDevelopment\Development\antiwork\cdngine\contracts\openapi\public.openapi.yaml`, and CDNgine correctly rejects that operation before publication.

CreatorAssistant must therefore enforce the invariant at publish time: a Backstage release is not published into Convex with a `cdngineDelivery` reference until the CDNgine version lifecycle state is `published`.

Raw creator uploads are stored as `cdngineSource` on the raw release artifact. They are authorized through `source/authorize` only when the server needs to inspect or rematerialize the original source. Installable package downloads, icons, and banners store `cdngineDelivery` only after their server-owned CDNgine version reaches `published`, and they are authorized through `deliveries/{deliveryScopeId}/authorize`.
