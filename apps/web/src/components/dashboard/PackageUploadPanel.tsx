import { useState } from 'react';
import { YucpButton } from '@/components/ui/YucpButton';
import { uploadPackageFile } from '@/lib/upload';

export function PackageUploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [packageId, setPackageId] = useState('');
  const [version, setVersion] = useState('');
  const [catalogProductId, setCatalogProductId] = useState('');
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  async function startUpload() {
    const normalizedPackageId = packageId.trim();
    const normalizedVersion = version.trim();
    const normalizedCatalogProductId = catalogProductId.trim() || undefined;
    if (!file || !normalizedPackageId || !normalizedVersion) {
      setError('Choose a package file and enter its package ID and version.');
      return;
    }

    setError(null);
    setIsComplete(false);
    setProgress(0);
    setIsUploading(true);
    try {
      await uploadPackageFile({
        file,
        packageId: normalizedPackageId,
        version: normalizedVersion,
        catalogProductId: normalizedCatalogProductId,
        onProgress: setProgress,
        onError: (uploadError) => {
          setError(uploadError.message || 'The upload failed.');
          setIsUploading(false);
        },
        onSuccess: () => {
          setProgress(100);
          setIsComplete(true);
          setIsUploading(false);
        },
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'The upload could not start.');
      setIsUploading(false);
    }
  }

  return (
    <section className="intg-card animate-in bento-col-12" aria-labelledby="package-upload-title">
      <div className="intg-header">
        <div className="intg-icon">
          <img src="/Icons/Library.png" alt="" aria-hidden="true" />
        </div>
        <div className="intg-copy">
          <h2 id="package-upload-title" className="intg-title">
            Upload a package
          </h2>
          <p className="intg-desc">
            Upload directly to the resumable ingest service. Supported files are .unitypackage,
            .zip, and .spp.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gap: '14px',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }}
      >
        <label className="modal-field">
          <span className="modal-label">Package ID</span>
          <input
            className="modal-input"
            value={packageId}
            onChange={(event) => setPackageId(event.currentTarget.value)}
            placeholder="com.creator.package"
            disabled={isUploading}
          />
        </label>
        <label className="modal-field">
          <span className="modal-label">Version</span>
          <input
            className="modal-input"
            value={version}
            onChange={(event) => setVersion(event.currentTarget.value)}
            placeholder="1.0.0"
            disabled={isUploading}
          />
        </label>
        <label className="modal-field">
          <span className="modal-label">Catalog product ID (optional)</span>
          <input
            className="modal-input"
            value={catalogProductId}
            onChange={(event) => setCatalogProductId(event.currentTarget.value)}
            disabled={isUploading}
          />
        </label>
      </div>

      <label className="modal-field">
        <span className="modal-label">Package file</span>
        <input
          className="modal-input"
          type="file"
          accept=".unitypackage,.zip,.spp"
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          disabled={isUploading}
        />
      </label>

      {isUploading || isComplete ? (
        <div className="modal-field" aria-live="polite">
          <span className="modal-label">
            {isComplete ? 'Upload complete' : `Uploading ${Math.round(progress)}%`}
          </span>
          <progress value={progress} max={100} style={{ width: '100%' }}>
            {Math.round(progress)}%
          </progress>
        </div>
      ) : null}
      {error ? (
        <p className="account-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      <YucpButton
        yucp="primary"
        pill
        isLoading={isUploading}
        isDisabled={!file || !packageId.trim() || !version.trim()}
        onPress={() => void startUpload()}
      >
        {isUploading ? 'Uploading...' : 'Start upload'}
      </YucpButton>
    </section>
  );
}
