# Package storage architecture research ledger

Date: 2026-07-22
Scope: storage minimization, content-defined deduplication, compressed chunk storage, CDN delivery, VCC compatibility, entitlement isolation, and per-buyer forensic coupling
Method: read the abstract or full architecture summary for each literature item, and read the current official page for each product-documentation item. Search-result pages, aggregators, and community answers are not counted. Duplicate editions of the same work are not counted.

This ledger makes the research basis auditable. It is not a vote. The architecture report cites the smaller set that directly controls a decision.

## Findings that survived the literature review

- Content-defined chunks must be the deduplication unit. The useful input is the normalized logical file tree, not an outer gzip or ZIP stream whose compressor spreads small changes across later bytes.
- `desync` implements rolling-hash CDC and per-chunk zstd compression. It also implements immutable chunks, indexes, caches, seeds, HTTP stores, S3 stores, and reconstruction. Its default is compressed storage. The current application disables that default.
- The measured starting profile is `64:256:1024 KiB`. The three-version Moonfang corpus added 792,561 bytes against the 64 KiB-average result. This is a 0.71 percent increase. Unique object count fell from 1,806 to 442. A larger corpus must ratify this parameter.
- Packing is not a launch requirement. Backblaze prices Class A, B, and C transactions as free. A 5 GiB transfer needs approximately 20,480 average 256 KiB chunks. Do not add a pack locator before measurements justify it. Xet, restic, Kopia, and Haystack show the later aggregation path.
- Native `caidx` and `caibx` indexes are the file/tree recipes. A small product manifest is still required for package identity, protection classification, entitlement binding, and final-tree hashes, but it must not duplicate desync's chunk recipe.
- Shared physical chunks cannot imply shared authorization. A short-lived capability authorizes one published version root, while an immutable membership set prevents the capability from becoming a chunk-oracle for the entire store. The internal CDN cache key contains only the buyer-independent namespace and digest.
- Xet is the closest published architecture to this workload, and its capable-client versus legacy reconstruction-bridge split is directly applicable. Its production CAS service is not currently available as a self-hostable component, so adopting `xet-core` would still require building the missing server. It does not replace the already working desync CAS.
- B2 is the only durable byte store. R2, OCI Archive, Cache Reserve, and a second storage copy do not improve this product's stated requirements enough to justify recurring duplicated storage.
- VCC cannot merge or personalize payloads. It can install a small ordinary VPM package that depends on the first-party importer. The importer performs the entitled product transfer and emits unlock telemetry.

## 100 architecture and systems references read

### CDC, deduplication, indexing, and locality

1. [A Low-Bandwidth Network File System](https://www.cs.princeton.edu/courses/archive/spring25/cos418/papers/lbfs.pdf), shift-resistant content-defined chunks for network transfer.
2. [Venti: a new approach to archival storage](https://www.usenix.org/legacy/events/fast02/quinlan.html), immutable hash-addressed blocks and recipes.
3. [Alternatives for Detecting Redundancy in Storage Systems Data](https://www.usenix.org/conference/2004-usenix-annual-technical-conference/alternatives-detecting-redundancy-storage-systems), whole-file, fixed-block, and Rabin CDC comparison.
4. [Data Domain deduplication study](https://www.usenix.org/legacy/event/fast08/tech/full_papers/zhu/zhu.pdf), locality and Bloom-filter-assisted chunk indexing.
5. [Sparse Indexing: Large Scale, Inline Deduplication Using Sampling and Locality](https://www.usenix.org/legacy/events/fast09/tech/full_papers/lillibridge/lillibridge.pdf), sampled index design.
6. [ChunkStash: Speeding Up Inline Storage Deduplication Using Flash Memory](https://www.usenix.org/legacy/events/atc10/tech/full_papers/Debnath.pdf), fingerprint-index lookup cost.
7. [SiLo: A Similarity-Locality Based Near-Exact Deduplication Scheme](https://doi.org/10.1109/MSST.2011.5937213), similarity plus locality indexing.
8. [A Study of Practical Deduplication](https://doi.org/10.1145/2078861.2078864), measured whole-file versus block-level savings.
9. [A Comprehensive Study of the Past, Present, and Future of Data Deduplication](https://doi.org/10.1109/JPROC.2016.2571298), deduplication taxonomy and trade-offs.
10. [A Survey and Classification of Storage Deduplication Systems](https://doi.org/10.1145/2611778), workload-specific system design.
11. [Efficient Deduplication Techniques for Modern Backup Operation](https://doi.org/10.1109/TC.2010.263), chunking and fingerprint-index design.
12. [A Thorough Investigation of Content-Defined Chunking Algorithms](https://arxiv.org/abs/2409.06066), current CDC throughput, distribution, and parameter comparison.
13. [The Design of Fast Content-Defined Chunking for Data Deduplication Based Storage Systems](https://doi.org/10.1109/TPDS.2020.2984632), FastCDC and normalized Gear chunking.
14. [A Fast Asymmetric Extremum Content Defined Chunking Algorithm](https://doi.org/10.1109/TC.2016.2595565), alternative CDC throughput and distribution.
15. [SeqCDC: Hashless Content-Defined Chunking for Data Deduplication](https://doi.org/10.1145/3652892.3700766), modern vector-friendly CDC.
16. [FastCDC](https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia), normalized Gear hashing and chunk-size distribution.
17. [Breaking and Fixing Content-Defined Chunking](https://eprint.iacr.org/2025/558), CDC information-leakage and hardening.
18. [Chunking Attacks on File Backup Services Using Content-Defined Chunking](https://arxiv.org/abs/2504.02095), observable chunk-boundary risk.
19. [Design Tradeoffs for Data Deduplication Performance in Backup Workloads](https://www.usenix.org/conference/fast15/technical-sessions/presentation/fu), backup, restore, memory, and storage parameter space.
20. [Tradeoffs in Scalable Data Routing for Deduplication Clusters](https://www.usenix.org/legacy/events/fast11/tech/full_papers/Dong.pdf), stateless versus stateful routing.
21. [Building a High-Performance Deduplication System](https://www.usenix.org/legacy/event/atc11/tech/final_files/GuoEfstathopoulos.pdf), scalable index and layout implementation.
22. [iDedup: Latency-Aware, Inline Data Deduplication for Primary Storage](https://www.usenix.org/conference/fast12/idedup-latency-aware-inline-data-deduplication-primary-storage), inline latency and fragmentation.
23. [I/O Deduplication](https://doi.org/10.1145/1837915.1837921), content similarity applied to I/O performance.
24. [Deduplicated restore-speed study](https://www.usenix.org/system/files/conference/fast13/fast13-final124.pdf), forward assembly, caching, and locality cost.
25. [ALACC: Accelerating Restore Performance Using Adaptive Look-Ahead Chunk Caching](https://www.usenix.org/conference/fast18/presentation/cao), container read amplification.
26. [Sliding Look-Back Window Assisted Data Chunk Rewriting](https://www.usenix.org/conference/fast19/presentation/cao), explicit storage-versus-restore trade-off.
27. [Accelerating Restore and Garbage Collection via Historical Information](https://www.usenix.org/conference/atc14/technical-sessions/presentation/fu_min), fragmentation and compact-container GC.
28. [The Dilemma between Deduplication and Locality](https://www.usenix.org/conference/fast21/presentation/zou), across-version layout and locality.
29. [The Logic of Physical Garbage Collection in Deduplicating Storage](https://www.usenix.org/conference/fast17/technical-sessions/presentation/douglis), commercial physical GC.
30. [Concurrent Deletion in a Distributed Content-Addressable Storage System](https://www.usenix.org/conference/fast13/technical-sessions/presentation/strzelczak), reference ownership and deletion.
31. [File Recipe Compression in Data Deduplication Systems](https://www.usenix.org/conference/fast13/technical-sessions/presentation/meister), recipe metadata size.
32. [Sketching Volume Capacities in Deduplicated Storage](https://www.usenix.org/conference/fast19/presentation/harnik), physical capacity attribution.
33. [DARE: Deduplication-Aware Resemblance Detection and Elimination](https://doi.org/10.1109/TC.2015.2456015), delta candidates from duplicate adjacency.
34. [Finesse: Feature-Locality Resemblance Detection](https://www.usenix.org/conference/fast19/presentation/zhang), post-dedup delta-compression cost.
35. [Fast and Lightweight Resemblance Detection for Post-Deduplication Delta Compression](https://doi.org/10.1145/3584663), resemblance throughput.
36. [Delta Compressed and Deduplicated Storage Using Stream-Informed Locality](https://www.usenix.org/conference/hotstorage12/workshop-program/presentation/shilane), extra savings and integrity cost.
37. [Migratory Compression](https://www.usenix.org/system/files/conference/fast14/fast14-paper_lin.pdf), grouping similar chunks for compression.
38. [Efficient Hybrid Inline and Out-of-Line Deduplication for Backup Storage](https://doi.org/10.1145/2641572), RevDedup and restore locality.
39. [Read-Performance Optimization for Deduplication-Based Storage Systems](https://doi.org/10.1145/2512348), restore fan-out.
40. [InftyDedup: Scalable and Cost-Effective Cloud Tiering with Deduplication](https://www.usenix.org/conference/fast23/presentation/kotlarska), cloud object and compute economics.
41. [TAPER: Tiered Approach for Eliminating Redundancy in Replica Synchronization](https://www.usenix.org/conference/fast-05/taper-tiered-approach-eliminating-redundancy-replica-synchronization), hierarchical matching and CDC transfer.
42. [Reliability Analysis of Deduplicated and Erasure-Coded Storage](https://doi.org/10.1145/1925019.1925021), shared-chunk failure amplification.

### Cross-tenant security and forensic attribution

43. [Side Channels in Cloud Services: Deduplication in Cloud Storage](https://doi.org/10.1109/MSP.2010.187), cross-user existence leakage.
44. [Message-Locked Encryption and Secure Deduplication](https://doi.org/10.1007/978-3-642-38348-9_17), formal convergent-encryption security.
45. [DupLESS: Server-Aided Encryption for Deduplicated Storage](https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/bellare), key-server boundary for dedupe.
46. [Proofs of Ownership in Remote Storage Systems](https://doi.org/10.1145/2046707.2046715), proving possession without trusting a hash claim.
47. [Optimal Symmetric Tardos Traitor Tracing Schemes](https://arxiv.org/abs/1107.3441), collusion-resistant code length and tracing.
48. [Collusion-Secure Fingerprinting for Digital Data](https://doi.org/10.1007/3-540-44750-4_28), Boneh-Shaw fingerprinting foundation.
49. [On Anti-Collusion Codes and Detection Algorithms for Multimedia Fingerprinting](https://doi.org/10.1109/TIT.2011.2146130), practical anti-collusion detection.
50. [A Capacity-Achieving Simple Decoder for Bias-Based Traitor Tracing](https://doi.org/10.1109/TIT.2015.2428250), decoder design and false-positive control.

### Deployed and standardized systems

51. [Xet protocol specification](https://huggingface.co/docs/xet/en/index), interoperable end-to-end CAS contract.
52. [Xet upload protocol](https://huggingface.co/docs/xet/upload-protocol), chunk, xorb, shard, and commit ordering.
53. [Xet download protocol](https://huggingface.co/docs/xet/download-protocol), reconstruction and signed multi-range retrieval.
54. [Xet CAS API](https://huggingface.co/docs/xet/api), global dedupe, reconstruction, xorb, and shard endpoints.
55. [Xet content-defined chunking](https://huggingface.co/docs/xet/chunking), 64 KiB target and deterministic boundaries.
56. [Xet xorb format](https://huggingface.co/docs/xet/en/xorb), chunk aggregation and per-chunk compression.
57. [Xet shard format](https://huggingface.co/docs/xet/en/shard), rebuildable file and xorb metadata.
58. [Xet deduplication](https://huggingface.co/docs/xet/main/deduplication), local and global dedupe flow.
59. [Xet authentication and authorization](https://huggingface.co/docs/xet/auth), short-lived repository-scoped tokens.
60. [`huggingface/xet-core`](https://github.com/huggingface/xet-core), Apache-2.0 reference client and formats.
61. [Migrating the Hugging Face Hub from Git LFS to Xet](https://huggingface.co/blog/migrating-the-hub-to-xet), production migration and S3-backed object flow.
62. [SteamPipe content system](https://partner.steamgames.com/doc/sdk/uploading), chunked game distribution and package-layout effects.
63. [Wharf protocol](https://itch.io/docs/wharf/), open incremental software-delivery protocol.
64. [Wharf design goals](https://itch.io/docs/wharf/design-goals.html), rsync-style block trade-offs.
65. [Butler offline diff and patch pipeline](https://itch.io/docs/butler/offline.html), client and server patch phases with verification.
66. [casync design rationale](https://0pointer.net/blog/casync-a-tool-for-distributing-file-system-images.html), CDC for CDN-friendly image delivery.
67. [`systemd/casync`](https://github.com/systemd/casync), open content-addressable synchronizer.
68. [`folbricht/desync`](https://github.com/folbricht/desync), casync-compatible Go implementation used by the current repository.
69. [OSTree overview](https://ostreedev.github.io/ostree/introduction/), versioned content-addressed trees.
70. [OSTree repository and static-delta formats](https://ostreedev.github.io/ostree/formats/), small-object request mitigation.
71. [restic repository design](https://github.com/restic/restic/blob/master/doc/design.rst), CDC, packs, footer indexes, and publication ordering.
72. [restic CDC foundation](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/), Rabin chunking behavior.
73. [Kopia architecture](https://kopia.io/docs/advanced/architecture/), pack-local and global indexes over object storage.
74. [Borg internals](https://borgbackup.readthedocs.io/en/stable/internals.html), repository-wide chunks, segments, and indexes.
75. [Git pack format](https://git-scm.com/docs/gitformat-pack), immutable object aggregation and delta chains.
76. [Git multi-pack index format](https://git-scm.com/docs/gitformat-pack#_multi_pack_index_midx_files), locating objects across immutable packs.
77. [Git LFS specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md), stable pointers over large-object storage.
78. [IPFS content-addressed, versioned file system](https://arxiv.org/abs/1407.3561), Merkle-linked block storage.
79. [CARv1 specification](https://ipld.io/specs/transport/car/carv1/), standard content-addressed record aggregation.
80. [CARv2 specification](https://ipld.io/specs/transport/car/carv2/), indexed random access over CAR data.
81. [OCI image specification](https://github.com/opencontainers/image-spec), content-addressed manifests and blobs.
82. [OCI distribution specification](https://github.com/opencontainers/distribution-spec), standard blob transport.
83. [Docker Registry HTTP API V2](https://distribution.github.io/distribution/spec/api/), resumable content-addressed blob upload and pull.
84. [The Update Framework specification](https://theupdateframework.github.io/specification/latest/), signed metadata roles and rollback protection.
85. [Uptane standard](https://uptane.org/docs/2.1.0/standard/uptane-standard), production software-update security.
86. [zsync](http://zsync.moria.org.uk/paper200503/), rsync-style updates through ordinary HTTP servers.
87. [The rsync algorithm](https://rsync.samba.org/tech_report/), remote delta transfer foundation.
88. [Nix store model](https://nixos.org/guides/nix-pills/11-garbage-collector.html), immutable paths, reachability, and GC.
89. [Netflix Open Connect overview](https://openconnect.netflix.com/Open-Connect-Overview.pdf), dedicated cache appliances and fill topology.
90. [Netflix Open Connect fill patterns](https://openconnect.zendesk.com/hc/en-us/articles/360035618071-Fill-patterns), popularity-driven cache population.
91. [Finding a Needle in Haystack](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf), packing small immutable objects to eliminate metadata I/O.
92. [f4: Facebook's Warm BLOB Storage System](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/muralidhar), workload-specific large-object storage.
93. [An Analysis of Facebook Photo Caching](https://engineering.fb.com/2014/02/27/web/an-analysis-of-facebook-photo-caching-2/), browser, edge, origin-cache, and object-store layers.
94. [The Google File System](https://research.google.com/archive/gfs.html), large immutable files and append-oriented storage.
95. [A Peek Behind Colossus](https://cloud.google.com/blog/products/storage-data-transfer/a-peek-behind-colossus-googles-file-system), separated scalable metadata and storage control.
96. [Windows Azure Storage](https://www.cs.purdue.edu/homes/csjgwang/CloudNativeDB/AzureStorageSOSP11.pdf), strongly consistent cloud object architecture.
97. [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), partitioning and availability trade-offs.
98. [Backblaze Vaults](https://www.backblaze.com/blog/?p=23801), the durability architecture already underneath B2.
99. [Cloudflare R2 architecture](https://blog.cloudflare.com/r2-open-beta/), object storage integrated with Cloudflare's network.
100.  [Nydus RAFS](https://nydus.dev/docs/concepts/rafs/), chunk-addressed container images and lazy remote reads.

## 100 official product documentation pages read

### Cloudflare Workers and Cache

1. [Workers overview](https://developers.cloudflare.com/workers/)
2. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
3. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
4. [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
5. [Workers Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/)
6. [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
7. [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/)
8. [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
9. [Workers logs](https://developers.cloudflare.com/workers/observability/logs/)
10. [Workers traces](https://developers.cloudflare.com/workers/observability/traces/)
11. [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
12. [Workers Cache overview](https://developers.cloudflare.com/workers/cache/)
13. [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
14. [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
15. [Workers Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
16. [Cache overview](https://developers.cloudflare.com/cache/)
17. [HEAD and Set-Cookie cache behavior](https://developers.cloudflare.com/cache/concepts/cache-behavior/)
18. [Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
19. [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/)
20. [Cloudflare cache responses](https://developers.cloudflare.com/cache/concepts/cache-responses/)
21. [CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)
22. [Retention versus freshness](https://developers.cloudflare.com/cache/concepts/retention-vs-freshness/)
23. [Cache revalidation](https://developers.cloudflare.com/cache/concepts/revalidation/)
24. [`Vary` behavior](https://developers.cloudflare.com/cache/concepts/vary/)
25. [Cache keys](https://developers.cloudflare.com/cache/how-to/cache-keys/)
26. [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/)
27. [Cache Reserve](https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/)
28. [Cache purge](https://developers.cloudflare.com/cache/how-to/purge-cache/)
29. [Workers and Cache](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/)
30. [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)

### Cloudflare R2, Queues, and Durable Objects

31. [R2 overview](https://developers.cloudflare.com/r2/)
32. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
33. [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
34. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
35. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
36. [R2 S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/)
37. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
38. [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
39. [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)
40. [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
41. [R2 multipart API from Workers](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
42. [R2 upload methods](https://developers.cloudflare.com/r2/objects/upload-objects/)
43. [R2 download methods](https://developers.cloudflare.com/r2/objects/download-objects/)
44. [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
45. [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
46. [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
47. [R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/)
48. [R2 Local Uploads](https://developers.cloudflare.com/r2/buckets/local-uploads/)
49. [R2 migration strategies](https://developers.cloudflare.com/r2/data-migration/migration-strategies/)
50. [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
51. [Queues overview](https://developers.cloudflare.com/queues/)
52. [Queue batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
53. [Queue consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
54. [Queue dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
55. [Queue pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
56. [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
57. [Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/)
58. [Queue limits](https://developers.cloudflare.com/queues/platform/limits/)
59. [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
60. [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
61. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
62. [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
63. [Durable Object storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

### Backblaze B2

64. [B2 overview](https://www.backblaze.com/docs/cloud-storage-about-backblaze-b2-cloud-storage)
65. [B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
66. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
67. [B2 transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing)
68. [Private B2 delivery through Cloudflare](https://www.backblaze.com/docs/cloud-storage-deliver-private-backblaze-b2-content-through-cloudflare-cdn)
69. [B2 file upload and management](https://www.backblaze.com/docs/cloud-storage-upload-and-manage-files)
70. [B2 Native API upload](https://www.backblaze.com/docs/cloud-storage-upload-files-with-the-native-api)
71. [B2 event-notification reference](https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide)
72. [B2 API families](https://www.backblaze.com/docs/cloud-storage-apis)
73. [B2 application keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
74. [B2 S3-compatible application keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys)
75. [B2 Native API](https://www.backblaze.com/docs/cloud-storage-native-api)
76. [B2 lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
77. [B2 files and exact file IDs](https://www.backblaze.com/docs/cloud-storage-files)
78. [B2 buckets](https://www.backblaze.com/docs/cloud-storage-buckets)
79. [B2 large files](https://www.backblaze.com/docs/cloud-storage-large-files)
80. [B2 Native API errors](https://www.backblaze.com/docs/cloud-storage-native-api-error-handling-and-status-codes)
81. [B2 Native API downloads](https://www.backblaze.com/docs/cloud-storage-download-files-with-the-native-api)
82. [B2 application-key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities)
83. [B2 file versions](https://www.backblaze.com/docs/cloud-storage-file-versions)

### Upload, package, archive, CAS, and control-plane documentation

84. [Uppy AWS S3 uploader](https://uppy.io/docs/aws-s3/)
85. [Uppy tus uploader](https://uppy.io/docs/tus/)
86. [tus resumable-upload protocol](https://tus.io/protocols/resumable-upload)
87. [VPM repository format](https://vcc.docs.vrchat.com/vpm/repos/)
88. [VPM package format](https://vcc.docs.vrchat.com/vpm/packages/)
89. [VCC package-listing guide](https://vcc.docs.vrchat.com/guides/create-listing/)
90. [VPM CLI](https://vcc.docs.vrchat.com/vpm/cli/)
91. [Go `archive/zip`](https://pkg.go.dev/archive/zip)
92. [Go `archive/tar`](https://pkg.go.dev/archive/tar)
93. [Go `compress/gzip`](https://pkg.go.dev/compress/gzip)
94. [desync README and feature contract](https://github.com/folbricht/desync/blob/master/README.md)
95. [desync Go API](https://pkg.go.dev/github.com/folbricht/desync)
96. [casync README and data structures](https://github.com/systemd/casync/blob/main/README.md)
97. [Unity asset-package format](https://docs.unity3d.com/Manual/AssetPackages.html)
98. [Unity package creation](https://docs.unity3d.com/Manual/AssetPackagesCreate.html)
99. [Convex production best practices](https://docs.convex.dev/production/best-practices)
100.  [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ)

## Count and quality check

- Architecture and systems references: 100.
- Official documentation pages: 100.
- The two numbered sets contain 200 entries. The architecture set contains 100 distinct URLs after removing the former duplicate Xet migration entry.
- Cloudflare pages were read from their current Markdown documentation endpoints where available.
- Product claims in the architecture report use primary documentation. Secondary literature is used only to explain trade-offs or provide independent analysis.
- The separate archival-storage proposal was removed. B2's own architecture and product controls were reviewed as the durable-storage boundary requested for this system.
